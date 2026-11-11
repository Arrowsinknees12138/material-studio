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

  const otherTab = await context.newPage();
  await otherTab.goto("/history");
  await otherTab.locator(".task-card").first().waitFor();
  assert.equal(await otherTab.locator(".task-card").count(), 1);
  const second = await submitTask();
  assert.equal(second.status, "QUEUED");
  await otherTab.locator(".task-card").nth(1).waitFor();
  await otherTab.close();
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
  await history.route("**/api/session", (route) => route.fulfill({ status: 503 }), { times: 1 });
  const resultPath = "/api/tasks/" + unattended + "/result";
  const firstThumbnail = Promise.withResolvers();
  const retriedThumbnail = Promise.withResolvers();
  const releaseThumbnails = Promise.withResolvers();
  let thumbnailReads = 0;
  await history.route((url) => url.pathname === resultPath, async (route) => {
    if (route.request().resourceType() === "image" && ++thumbnailReads <= 2) {
      (thumbnailReads === 1 ? firstThumbnail : retriedThumbnail).resolve(route.request());
      await releaseThumbnails.promise;
      return route.fulfill({ status: 503 }).catch(() => {});
    }
    return route.continue();
  });
  await history.goto("/history");
  await history.getByText("暂时无法确认登录状态").waitFor();
  assert.equal(await history.getByRole("button", { name: "使用周野" }).count(), 0);
  await history.getByRole("button", { name: "重新检查账号" }).click();
  const fallback = history.getByText("打开预览", { exact: true });
  await firstThumbnail.promise;
  await history.getByText("正在加载缩略图…", { exact: true }).first().waitFor();
  await history.getByRole("button", { name: "刷新历史记录" }).click();
  assert.equal(new URL((await retriedThumbnail.promise).url()).searchParams.get("thumbnailAttempt"), "1");
  await fallback.waitFor();
  releaseThumbnails.resolve();
  await fallback.click();
  await history.getByRole("dialog").getByRole("img", { name: "沙丘日记制作结果" }).waitFor();
  await history.keyboard.press("Escape");
  await history.getByRole("dialog").waitFor({ state: "hidden" });
  await history.waitForFunction((path) => [...document.images].some((image) =>
    new URL(image.src).pathname === path && image.naturalWidth > 0), resultPath);
  assert.equal(thumbnailReads, 3);
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
  const olderPageStarted = Promise.withResolvers();
  const failOlderPage = Promise.withResolvers();
  let interruptedCursor;
  await history.route((url) => url.pathname === "/api/tasks/history", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("active")) return route.fulfill({ json: { items: [], nextCursor: null } });
    const cursor = query.get("cursor");
    if (cursor && !interruptedCursor) {
      interruptedCursor = cursor;
      olderPageStarted.resolve();
      await failOlderPage.promise;
      return route.fulfill({ status: 503, json: { message: "较早的记录读取失败。" } });
    }
    const start = cursor ? rows.findIndex((item) => item.id === cursor) + 1 : 0;
    const items = rows.slice(start, start + 20);
    const nextCursor = start + items.length < rows.length ? items.at(-1).id : null;
    await route.fulfill({ json: { items, nextCursor } });
  });
  await history.goto("/history");
  const loadMore = history.getByRole("button", { name: "加载更多记录" });
  await loadMore.click();
  await olderPageStarted.promise;
  rows = [...records(22, 22), ...rows];
  await history.evaluate(() => window.dispatchEvent(new Event("focus")));
  const headRefresh = history.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/tasks/history" && !url.searchParams.has("active") && !url.searchParams.has("cursor");
  });
  failOlderPage.resolve();
  assert.equal((await headRefresh).status(), 200);
  await history.getByText("分页记录 22", { exact: true }).waitFor();
  await history.getByText("较早的记录读取失败。", { exact: true }).waitFor();
  const retriedPage = history.waitForRequest((request) =>
    new URL(request.url()).searchParams.get("cursor") === interruptedCursor);
  await history.getByRole("button", { name: "重试加载更多" }).click();
  await retriedPage;
  await history.getByText("分页记录 1", { exact: true }).waitFor();
  assert.equal(await history.getByText("较早的记录读取失败。", { exact: true }).count(), 0);
  await loadMore.waitFor({ state: "hidden" });
  assert.equal(await history.locator(".task-card").count(), 22);

  rows = [...records(23, 43), ...rows];
  await history.getByRole("button", { name: "刷新历史记录" }).click();
  await history.getByText("分页记录 43", { exact: true }).waitFor();
  assert.equal(await history.getByText("分页记录 23", { exact: true }).count(), 0);
  await loadMore.click();
  await history.getByText("分页记录 23", { exact: true }).waitFor();
  assert.equal(await history.locator(".task-card").count(), 43);
  await loadMore.waitFor({ state: "hidden" });

  await history.getByRole("button", { name: "当前账号与切换" }).click();
  const dialog = history.getByRole("dialog");
  const signOut = dialog.getByRole("button", { name: "退出登录" });
  await history.route("**/api/session/logout", (route) => route.abort("connectionreset"), { times: 1 });
  await signOut.click();
  await dialog.getByText("当前账号仍处于登录状态，请重试退出。").waitFor();

  let signedOutOnServer = false;
  await history.route("**/api/session/logout", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 204);
    signedOutOnServer = true;
    await route.abort("connectionreset");
  }, { times: 1 });
  await history.route("**/api/session", (route) => signedOutOnServer
    ? route.fulfill({ status: 503 }) : route.fallback(), { times: 1 });
  await signOut.click();
  await dialog.getByText("暂时无法确认登录状态").waitFor();
  assert.equal(await history.locator(".task-card").count(), 0);
  await dialog.getByRole("button", { name: "重新检查账号" }).click();
  await dialog.waitFor({ state: "hidden" });
  await history.getByRole("button", { name: "使用周野" }).waitFor();
  assert.deepEqual(await (await history.request.get("/api/session")).json(), { user: null });

  await history.getByRole("textbox", { name: /用户名/ }).fill("zhou");
  await history.getByLabel(/密码/).fill("incorrect");
  await history.getByRole("button", { name: "登录", exact: true }).click();
  await history.getByText("账号或密码错误。").waitFor();
  await history.getByRole("tab", { name: "注册账号" }).click();
  assert.equal(await history.getByText("账号或密码错误。").count(), 0);
  await history.getByRole("textbox", { name: /用户名/ }).fill("invalid-registration");
  await history.getByRole("textbox", { name: /显示名称/ }).fill("测试");
  await history.getByLabel(/密码/).fill("short");
  await history.getByRole("button", { name: "注册并登录" }).click();
  const registrationError = history.getByText("密码至少 8 个字符，UTF-8 编码最多 72 字节。", { exact: true });
  await registrationError.waitFor();
  await history.getByRole("tab", { name: "账号登录" }).click();
  assert.equal(await registrationError.count(), 0);
  console.log("Catalog, idempotent retry, cross-tab tracking, session and thumbnail recovery, and history pagination verified.");
} finally {
  await browser.close();
}
