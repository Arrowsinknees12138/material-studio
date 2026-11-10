import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

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
  if (unused) await request(web, "/api/assets/" + unused + "/content", { cookie, status: 404 });
  console.log("Recovered task, result, permissions and asset references verified.");
}

switch (mode) {
  case "prepare-restart": await prepare(true); break;
  case "prepare-outage": await prepare(false); break;
  case "verify": await verify(); break;
  default: assert.fail("Unknown smoke command " + mode);
}
