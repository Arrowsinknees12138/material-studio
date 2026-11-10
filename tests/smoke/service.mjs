import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";

const web = "http://web:3000";
const [mode, ...args] = process.argv.slice(2);

async function request(base, path, { cookie, json, form, status = 200 } = {}) {
  const headers = { "X-Studio-Request": "1" };
  if (cookie) headers.Cookie = cookie;
  if (json) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, {
    method: json || form ? "POST" : "GET",
    headers,
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, status, path);
  return response;
}

async function login(base, username = "lin") {
  const response = await request(base, "/api/session", { json: { username, password: "studio-demo" } });
  assert.equal((await response.json()).user.username, username);
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  assert.match(cookie, /^STUDIO_SESSION=/);
  return cookie;
}

async function upload(base, cookie) {
  const photo = await request(web, "/demo/moon.jpg");
  const form = new FormData();
  form.set("templateId", "moon");
  form.set("file", await photo.blob(), "moon.jpg");
  return (await (await request(base, "/api/assets", { cookie, form, status: 201 })).json()).assetId;
}

async function submit(base, cookie, assetId, delayMs, failAt) {
  const response = await request(base, "/api/tasks", { cookie, status: 202, json: {
    templateId: "moon", assetIds: [assetId], requestId: crypto.randomUUID(), delayMs, failAt,
  } });
  return (await response.json()).id;
}

async function waitForTask(cookie, id, predicate, retryUnavailable = false) {
  const deadline = Date.now() + 45000;
  let last;
  do {
    try {
      const response = await request(web, "/api/tasks/" + id, { cookie });
      last = await response.json();
    } catch (error) {
      if (!retryUnavailable) throw error;
      await sleep(250);
      continue;
    }
    if (predicate(last)) return last;
    assert.ok(!["FAILED", "SUCCEEDED"].includes(last.status), JSON.stringify(last));
    await sleep(150);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for task " + id + ": " + JSON.stringify(last));
}

function png(width, height) {
  function chunk(type, data) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.write(type, 4);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
    return Buffer.concat([header, data, checksum]);
  }
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(width);
  dimensions.writeUInt32BE(height, 4);
  dimensions[8] = 8; // Grayscale with 8 bits per pixel.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", dimensions),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function validate() {
  const catalog = await (await request(web, "/api/templates")).json();
  assert.equal(catalog.categories.length, 3);
  assert.equal(catalog.templates.length, 6);
  for (const category of catalog.categories) {
    const filtered = await (await request(web, "/api/templates?category=" + encodeURIComponent(category))).json();
    assert.ok(filtered.templates.length > 0);
    assert.ok(filtered.templates.every((template) => template.category === category));
  }
  for (const template of catalog.templates) {
    const cover = await request(web, template.coverUrl);
    assert.equal(cover.headers.get("content-type"), "image/jpeg");
    assert.ok((await cover.arrayBuffer()).byteLength > 1000);
  }
  const empty = await (await request(web, "/api/templates?category=nonexistent")).json();
  assert.deepEqual(empty.templates, []);
  await request(web, "/api/templates/nonexistent", { status: 404 });

  const template = await (await request(web, "/api/templates/moon")).json();
  assert.equal(template.maxImagePixels, 24_000_000);
  assert.equal(template.maxFileSizeBytes, 5 * 1024 ** 2);
  const capped = await (await request(web, "/api/templates/garden")).json();
  assert.equal(capped.maxFileSizeBytes, template.maxFileSizeBytes);
  assert.equal(catalog.templates.find((item) => item.id === "garden").maxFileSizeBytes, capped.maxFileSizeBytes);
  const cookie = await login(web, "zhou");
  const missingFile = new FormData();
  missingFile.set("templateId", "moon");
  const missing = await request(web, "/api/assets", { cookie, form: missingFile, status: 400 });
  assert.equal((await missing.json()).message, "请选择要上传的图片。");
  const invalidLimit = await request(web, "/api/tasks/history?limit=bad", { cookie, status: 400 });
  assert.equal((await invalidLimit.json()).message, "参数 limit 格式无效。");
  async function uploadPng(bytes, status) {
    const form = new FormData();
    form.set("templateId", "moon");
    form.set("file", new Blob([bytes], { type: "image/png" }), "validation.png");
    return (await request(web, "/api/assets", { cookie, form, status })).json();
  }
  const validPng = png(2, 2);
  const asset = await uploadPng(validPng, 201);
  const preview = await request(web, asset.previewUrl, { cookie });
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), validPng);
  const other = await login(web, "lin");
  await request(web, asset.previewUrl, { cookie: other, status: 404 });
  await request(web, asset.previewUrl, { status: 401 });
  await uploadPng(validPng.subarray(0, 12), 400);
  const oversized = png(5000, 5000);
  assert.ok(oversized.length < template.maxFileSizeBytes);
  assert.match((await uploadPng(oversized, 400)).message, /2400 万像素/);
  await uploadPng(Buffer.alloc(template.maxFileSizeBytes + 1), 413);

  const input = { templateId: "moon", assetIds: [asset.assetId], delayMs: 2000 };
  async function create(overrides, status = 202) {
    return (await request(web, "/api/tasks", {
      cookie, status, json: { ...input, requestId: crypto.randomUUID(), ...overrides },
    })).json();
  }
  await create({ assetIds: [] }, 400);
  await create({ templateId: "desert" }, 400);
  await create({ delayMs: -1 }, 400);
  await create({ delayMs: 1.5 }, 400);
  await create({ failAt: 1 }, 400);
  await create({ failAt: "UNKNOWN" }, 400);
  const requestId = crypto.randomUUID();
  const [first, duplicate] = await Promise.all([create({ requestId }), create({ requestId })]);
  assert.equal(first.id, duplicate.id);

  const stages = ["CHECK_INPUTS", "GENERATE", "FINALIZE"];
  const failedTasks = await Promise.all(stages.map(async (stage) =>
    (await create({ failAt: stage, delayMs: 0 })).id));
  const seen = [];
  const success = await waitForTask(cookie, first.id, (task) => {
    if (task.stage && task.stage !== seen.at(-1)) seen.push(task.stage);
    return task.status === "SUCCEEDED";
  });
  assert.deepEqual(seen, stages);
  for (const [index, id] of failedTasks.entries()) {
    const task = await waitForTask(cookie, id, (item) => item.status === "FAILED");
    assert.equal(task.stage, stages[index]);
    assert.match(task.errorMessage, /模拟失败/);
    assert.equal(task.resultUrl, null);
  }
  const result = await request(web, success.resultUrl, { cookie });
  assert.equal(result.headers.get("content-type"), "image/jpeg");
  assert.ok((await result.arrayBuffer()).byteLength > 1000);
  const terminal = await (await request(web, "/api/tasks/updates?ids=" + [first.id, ...failedTasks].join(","), { cookie })).json();
  assert.equal(terminal.length, 4);
  assert.equal(terminal.find((task) => task.id === first.id).status, "SUCCEEDED");
  assert.ok(terminal.filter((task) => task.id !== first.id).every((task) => task.status === "FAILED"));
  console.log("Catalog, upload boundaries, concurrent idempotency, three stages and terminal states verified.");
}

async function prepare(restart) {
  const [first, second] = args.map((ip) => "http://" + ip + ":8080");
  assert.notEqual(first, second);
  const cookie = await login(first);
  const session = await request(second, "/api/session", { cookie });
  assert.equal((await session.json()).user.username, "lin");

  const used = await upload(first, cookie);
  assert.ok((await (await request(second, "/api/assets/" + used + "/content", { cookie })).arrayBuffer()).byteLength > 1000);
  const unused = restart ? await upload(second, cookie) : null;
  if (restart) {
    const failing = await submit(first, cookie, used, 0, "GENERATE");
    const failed = await waitForTask(cookie, failing, (task) => task.status === "FAILED");
    assert.equal(failed.stage, "GENERATE");
    assert.match(failed.errorMessage, /模拟生成/);
  }

  const id = await submit(second, cookie, used, 6000);
  const targetStage = restart ? "GENERATE" : "CHECK_INPUTS";
  await waitForTask(cookie, id, (task) => task.status === "RUNNING" && task.stage === targetStage);
  const active = await (await request(web, "/api/tasks/history?active=true&limit=50", { cookie })).json();
  assert.ok(active.items.some((task) => task.id === id));
  if (restart) {
    const firstPage = await (await request(web, "/api/tasks/history?limit=1", { cookie })).json();
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await (await request(web, "/api/tasks/history?limit=1&cursor="
      + encodeURIComponent(firstPage.nextCursor), { cookie })).json();
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);
    const updates = await (await request(web, "/api/tasks/updates?ids=" + [id, secondPage.items[0].id],
      { cookie })).json();
    assert.ok(updates.some((task) => task.id === id));
  }
  console.log([id, used, unused].filter(Boolean).join(" "));
}

async function verify() {
  const [id, used, unused] = args;
  let cookie;
  // The database process is healthy before this command, but pooled connections may still reconnect.
  const deadline = Date.now() + 25000;
  while (!cookie) {
    try {
      cookie = await login(web);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(250);
    }
  }
  const done = await waitForTask(cookie, id, (task) => task.status === "SUCCEEDED", true);
  assert.ok((await (await request(web, done.resultUrl, { cookie })).arrayBuffer()).byteLength > 1000);
  await request(web, "/api/assets/" + used + "/content", { cookie });
  const other = await login(web, "zhou");
  await request(web, "/api/tasks/" + id, { cookie: other, status: 404 });
  await request(web, done.resultUrl, { cookie: other, status: 404 });
  const foreignBatch = await request(web, "/api/tasks/updates?ids=" + id, { cookie: other });
  assert.deepEqual(await foreignBatch.json(), []);
  if (unused) {
    await request(web, "/api/assets/" + unused + "/content", { cookie, status: 404 });
    const expired = await request(web, "/api/tasks", { cookie, status: 400, json: {
      templateId: "moon", assetIds: [unused], requestId: crypto.randomUUID(),
    } });
    assert.deepEqual((await expired.json()).unavailableAssetIds, [unused]);
  }
  console.log("Recovered task, result, permissions and asset references verified.");
}

switch (mode) {
  case "validate": await validate(); break;
  case "prepare-restart": await prepare(true); break;
  case "prepare-outage": await prepare(false); break;
  case "verify": await verify(); break;
  default: assert.fail("Unknown smoke command " + mode);
}
