import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ baseURL: "http://web:3000", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);

  await page.route("**/api/templates", (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.route((url) => url.pathname === "/demo/desert.jpg" && !url.searchParams.has("attempt"),
    (route) => route.fulfill({ status: 503 }));
  await page.goto("/templates");
  await page.getByRole("alert").getByText("模板暂时无法加载").waitFor();
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByText("6 款模板", { exact: true }).waitFor();
  const desertCard = page.locator(".template-card").filter({ hasText: "沙丘日记" });
  await desertCard.getByText("封面暂时无法加载。").waitFor();
  await desertCard.getByRole("button", { name: "重试沙丘日记封面" }).click();
  await desertCard.locator("img").waitFor();

  await page.route((url) => url.pathname === "/api/templates" && url.searchParams.has("category"),
    (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.getByRole("button", { name: "旅行风景" }).click();
  await page.getByRole("alert").getByText("模板暂时无法加载").waitFor();
  assert.equal(await page.locator(".catalog-count").innerText(), "加载失败");
  assert.equal(await page.getByText("6 款模板", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByText("2 款模板", { exact: true }).waitFor();
  assert.equal(await page.locator(".template-card").count(), 2);
  await page.getByRole("link", { name: /沙丘日记/ }).press("Enter");
  await page.getByRole("heading", { name: /沙丘日记/ }).waitFor();
  const workspaceCover = page.locator(".workspace-cover");
  await workspaceCover.getByText("封面暂时无法加载。").waitFor();
  await workspaceCover.getByRole("button", { name: "重试沙丘日记封面" }).press("Enter");
  await workspaceCover.getByRole("img", { name: "沙丘日记模板封面" }).waitFor();
  await page.getByRole("button", { name: "使用周野" }).click();
  const sample = await page.request.get("/demo/desert.jpg");
  assert.ok(sample.ok());
  await page.locator('input[type="file"]').setInputFiles({
    name: "workflow.jpg", mimeType: "image/jpeg", buffer: await sample.body(),
  });
  await page.getByRole("img", { name: "素材 1 预览" }).waitFor();

  const submit = page.getByRole("button", { name: "提交制作" });
  const ids = [];
  const batches = [];
  let injectQueryError = true;
  await page.route("**/api/tasks/updates?*", async (route) => {
    const batch = new URL(route.request().url()).searchParams.get("ids").split(",");
    batches.push(batch);
    if (injectQueryError && ids.length === 2 && ids.every((id) => batch.includes(id))) {
      injectQueryError = false;
      await route.fulfill({ status: 503, json: { message: "查询服务暂时不可用。" } });
    } else {
      await route.continue();
    }
  });

  async function submitTask() {
    const response = page.waitForResponse((res) =>
      new URL(res.url()).pathname === "/api/tasks" && res.request().method() === "POST");
    await submit.click();
    const accepted = await response;
    assert.equal(accepted.status(), 202, await accepted.text());
    return accepted.json();
  }

  let lost;
  await page.route("**/api/tasks", async (route) => {
    const response = await route.fetch();
    lost = { input: route.request().postDataJSON(), status: response.status(), task: await response.json() };
    await route.abort("connectionreset");
  }, { times: 1 });
  await submit.click();
  await page.getByRole("alert").getByText("网络连接暂时不可用，请重试。").waitFor();
  assert.equal(lost.status, 202);
  assert.equal(lost.task.status, "QUEUED");
  assert.equal(await page.locator(".task-card").count(), 0);

  const replay = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/tasks" && request.method() === "POST");
  const first = await submitTask();
  assert.deepEqual((await replay).postDataJSON(), lost.input);
  assert.equal(first.id, lost.task.id);
  const persisted = await page.request.get("/api/tasks?templateId=desert");
  assert.ok(persisted.ok());
  assert.deepEqual((await persisted.json()).map((task) => task.id), [first.id]);

  const second = await submitTask();
  assert.equal(second.status, "QUEUED");
  ids.push(first.id, second.id);
  assert.notEqual(ids[0], ids[1]);
  const retry = page.getByRole("button", { name: "重新查询" }).first();
  await retry.waitFor();
  assert.equal(await page.getByText("制作失败", { exact: true }).count(), 0);
  assert.equal(await page.locator(".task-card").count(), 2);
  const recovered = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/tasks/updates" && res.ok());
  await retry.click();
  await recovered;
  await page.getByText("处理中", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("处理中", { exact: true }).first().waitFor();
  for (const id of ids) {
    await page.locator('img[src="/api/tasks/' + id + '/result"]').waitFor({ timeout: 22000 });
  }
  const previousBatchCount = batches.length;
  await sleep(2500);
  assert.equal(batches.length, previousBatchCount, "Idle history must stop polling");

  // Refresh resets the form. Select a new asset before submitting the task we leave running.
  await page.locator('input[type="file"]').setInputFiles({
    name: "close-page.jpg", mimeType: "image/jpeg", buffer: await sample.body(),
  });
  const unattended = (await submitTask()).id;
  await page.close();
  const deadline = Date.now() + 22000;
  while (true) {
    const response = await context.request.get("/api/tasks/" + unattended);
    assert.ok(response.ok());
    const task = await response.json();
    if (task.status === "SUCCEEDED") break;
    assert.notEqual(task.status, "FAILED", task.errorMessage);
    assert.ok(Date.now() < deadline, "Task did not finish after closing the page");
    await sleep(300);
  }
  const history = await context.newPage();
  await history.goto("/history");
  await history.locator('img[src="/api/tasks/' + unattended + '/result"]').waitFor();
  await history.goto("/templates/nonexistent");
  await history.getByRole("heading", { name: "找不到这个模板" }).waitFor();

  function records(from, to) {
    return Array.from({ length: to - from + 1 }, (_, index) => {
      const number = to - index;
      return {
        id: "history-" + number, templateId: "desert", templateTitle: "沙丘日记",
        status: "FAILED", stage: "GENERATE", errorMessage: "分页记录 " + number,
        createdAt: new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString(),
        completedAt: null, resultUrl: null,
      };
    });
  }
  let rows = records(1, 21);
  await history.route((url) => url.pathname === "/api/tasks/history", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("active")) return route.fulfill({ json: { items: [], nextCursor: null } });
    const cursor = query.get("cursor");
    const start = cursor ? rows.findIndex((item) => item.id === cursor) + 1 : 0;
    const items = rows.slice(start, start + 20);
    const nextCursor = start + items.length < rows.length ? items.at(-1).id : null;
    await route.fulfill({ json: { items, nextCursor } });
  });
  await history.goto("/history");
  const loadMore = history.getByRole("button", { name: "加载更多记录" });
  await loadMore.click();
  await history.getByText("分页记录 1", { exact: true }).waitFor();
  await loadMore.waitFor({ state: "hidden" });

  rows = [...records(22, 42), ...rows];
  await history.getByRole("button", { name: "刷新历史记录" }).click();
  await history.getByText("分页记录 42", { exact: true }).waitFor();
  assert.equal(await history.getByText("分页记录 22", { exact: true }).count(), 0);
  await loadMore.click();
  await history.getByText("分页记录 22", { exact: true }).waitFor();
  assert.equal(await history.locator(".task-card").count(), 42);
  console.log("Catalog, idempotent retry, query recovery, refresh and close lifecycle, and disjoint history pagination verified.");
} finally {
  await browser.close();
}
