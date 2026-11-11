import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const baseURL = "http://web:3000";
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 } });
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => console.error(error));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, description) {
  const timeout = Symbol();
  const result = await Promise.race([promise, sleep(12000, timeout, { ref: false })]);
  assert.notEqual(result, timeout, description);
  return result;
}

const held = [];
try {
  const image = await page.request.get("/demo/desert.jpg");
  assert.ok(image.ok());
  const bytes = await image.body();

  await page.goto("/templates/desert");
  const requirements = page.locator("#template-image-requirements");
  await requirements.waitFor();
  assert.equal(await requirements.innerText(),
    "素材要求 · 1 张图片 · JPEG / PNG · 单张 ≤ 5 MB · 单张 ≤ 2400 万像素");
  assert.equal(await page.locator("input[type=file]").count(), 0);
  await page.getByRole("button", { name: "使用林夏", disabled: false }).press("Enter");
  const choose = page.getByRole("button", { name: "选择素材 1" });
  const replace = page.getByRole("button", { name: "替换素材 1" });
  const remove = page.getByRole("button", { name: "移除素材 1" });
  const preview = page.getByRole("img", { name: "素材 1 预览" });
  const submit = page.getByRole("button", { name: "提交制作" });
  const slot = page.locator(".upload-slot");
  await choose.and(page.locator(":focus")).waitFor();
  await page.getByText(/单张 ≤ 2400 万像素/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator(".workspace-grid").evaluate((grid) => {
    const [editor, history] = grid.children;
    return history.getBoundingClientRect().top >= editor.getBoundingClientRect().bottom;
  }), true);

  await page.getByRole("link", { name: "跳转到主要内容" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await choose.evaluate((node) => node === document.activeElement), true);

  async function select(button, name, mimeType = "", buffer = bytes) {
    const event = page.waitForEvent("filechooser");
    await button.press("Enter");
    await (await event).setFiles({ name, mimeType, buffer });
  }

  await select(choose, "spoofed.jpg", "image/jpeg", Buffer.from("not a JPEG"));
  await slot.getByRole("alert").getByText("请选择有效的 JPEG 或 PNG 图片。").waitFor();
  assert.equal(await submit.isDisabled(), true);

  async function holdUpload(filename) {
    const started = deferred();
    const release = deferred();
    held.push(release);
    const completed = deferred();
    await page.route("**/api/assets", async (route) => {
      if (!route.request().postDataBuffer()?.includes(Buffer.from(filename))) {
        await route.fallback();
        return;
      }
      started.resolve();
      try {
        await release.promise;
        await route.fulfill({ status: 201, json: {
          assetId: "stale", previewUrl: "/demo/moon.jpg", contentType: "image/jpeg", byteSize: 10,
        } });
      } catch {
        // The browser may have already cancelled the intercepted request.
      } finally {
        completed.resolve();
      }
    });
    return { started: started.promise, release: release.resolve, completed: completed.promise };
  }

  const old = await holdUpload("pending-replacement.jpg");
  await select(replace, "pending-replacement.jpg");
  await within(old.started, "old.started");
  await select(replace, "keep-without-mime-" + "a".repeat(120) + ".jpg");
  await preview.waitFor();
  const current = await preview.getAttribute("src");
  assert.match(current, /^blob:/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  old.release();
  await within(old.completed, "old.completed");
  assert.equal(await preview.getAttribute("src"), current);
  assert.equal(await submit.isEnabled(), true);

  const removed = await holdUpload("pending-removal.jpg");
  await select(replace, "pending-removal.jpg");
  await within(removed.started, "removed.started");
  await remove.press("Enter");
  await choose.waitFor();
  assert.equal(await choose.evaluate((node) => node === document.activeElement), true);
  removed.release();
  await within(removed.completed, "removed.completed");
  assert.equal(await preview.count(), 0);
  assert.equal(await submit.isDisabled(), true);

  const assetContent = /\/api\/assets\/[^/]+\/content(?:\?|$)/;
  let failedPreview;
  await page.route(assetContent, async (route) => {
    failedPreview = new URL(route.request().url());
    await route.fulfill({ status: 503 });
  }, { times: 1 });
  await select(choose, "last.jpg");
  await slot.getByRole("alert").getByText("素材预览暂时无法加载。").waitFor();
  assert.equal(await preview.count(), 0);
  assert.equal(await submit.isDisabled(), true);
  const slowPreview = deferred();
  const releasePreview = deferred();
  const previewSettled = deferred();
  held.push(releasePreview);
  await page.route(assetContent, async (route) => {
    slowPreview.resolve(new URL(route.request().url()));
    try {
      await releasePreview.promise;
      await route.fulfill({ status: 503 });
    } catch {
      // The preview deadline can cancel the request before the route is released.
    } finally {
      previewSettled.resolve();
    }
  }, { times: 1 });
  const retryPreview = slot.getByRole("button", { name: "重试预览" });
  await retryPreview.press("Enter");
  const stalledPreview = await within(slowPreview.promise, "preview retry did not reach the server");
  assert.equal(stalledPreview.pathname, failedPreview.pathname);
  assert.equal(stalledPreview.searchParams.get("attempt"), "1");
  await slot.getByRole("status").getByText("正在加载素材预览…").waitFor();
  await slot.getByRole("alert").getByText("素材预览暂时无法加载。").waitFor();
  assert.equal(await submit.isDisabled(), true);

  const retriedPreview = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === failedPreview.pathname && url.searchParams.get("attempt") === "2";
  });
  await retryPreview.press("Enter");
  await retriedPreview;
  await preview.waitFor();
  assert.ok(await preview.evaluate((img) => img.naturalWidth > 0));
  releasePreview.resolve();
  await within(previewSettled.promise, "timed-out preview route did not settle");
  assert.equal(await slot.getByRole("alert").count(), 0);
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await replace.evaluate((node) => node === document.activeElement), true);
  const resultContent = /\/api\/tasks\/[^/]+\/result(?:\?|$)/;
  const failInitialResult = (route) => new URL(route.request().url()).searchParams.has("attempt")
    ? route.fallback() : route.fulfill({ status: 503 });
  await page.route(resultContent, failInitialResult);
  const accepted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
  await submit.press("Enter");
  const submission = await accepted;
  assert.equal(submission.status(), 202, await submission.text());
  const submittedId = (await submission.json()).id;
  await page.getByText("任务已受理，可以在记录中查看进度。", { exact: true }).waitFor();
  const result = page.getByRole("button", { name: "预览沙丘日记的结果" }).first();
  await result.getByText("打开预览").waitFor({ timeout: 25000 });
  await result.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("alert").getByText("结果图片暂时无法加载。").waitFor();
  assert.equal(await page.getByText("制作成功", { exact: true }).count(), 1);
  const slowResult = deferred();
  const releaseResult = deferred();
  const resultSettled = deferred();
  held.push(releaseResult);
  await page.route((url) => resultContent.test(url.pathname) && url.searchParams.get("attempt") === "1",
    async (route) => {
      slowResult.resolve(route.request());
      try {
        await releaseResult.promise;
        await route.fulfill({ status: 503 });
      } catch {
        // The deadline can cancel the request while Playwright holds its response.
      } finally {
        resultSettled.resolve();
      }
    }, { times: 1 });
  const retryResult = dialog.getByRole("button", { name: "重新加载图片" });
  await retryResult.press("Enter");
  const stalledResult = await within(slowResult.promise, "result retry did not reach the proxy");
  assert.equal(stalledResult.headers()["x-studio-account"], "lin");
  await dialog.getByRole("status").getByText("正在加载结果图片…").waitFor();
  await dialog.getByRole("alert").getByText("请求超时，请重试。").waitFor();
  assert.equal(await page.getByText("制作成功", { exact: true }).count(), 1);
  await retryResult.press("Enter");
  await dialog.getByRole("img", { name: "沙丘日记制作结果" }).waitFor();
  assert.ok(await dialog.locator("img").evaluate((img) => img.naturalWidth > 0));
  releaseResult.resolve();
  await within(resultSettled.promise, "timed-out result route did not settle");
  assert.equal(await dialog.getByRole("alert").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await result.evaluate((node) => node === document.activeElement), true);

  await page.unroute(resultContent, failInitialResult);
  const expiredSession = await page.request.post("/api/session/logout", { headers: { "X-Studio-Request": "1" } });
  assert.equal(expiredSession.status(), 204);
  const unauthorizedResult = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/tasks/" + submittedId + "/result"
    && response.request().resourceType() === "fetch");
  await result.press("Enter");
  assert.equal((await unauthorizedResult).status(), 401);
  const signInAgain = page.getByRole("button", { name: "使用林夏" });
  await signInAgain.waitFor();
  await dialog.waitFor({ state: "hidden" });
  await result.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".avatar").filter({ hasText: /^林$/ }).count(), 0);
  await signInAgain.click();
  await result.waitFor();

  const previousHistory = deferred();
  const releaseHistory = deferred();
  const historySettled = deferred();
  held.push(releaseHistory);
  await page.route((url) => url.pathname === "/api/tasks/history" && !url.searchParams.has("active"),
    async (route) => {
      const response = await route.fetch();
      previousHistory.resolve({ request: route.request(), status: response.status(), body: await response.json() });
      try {
        await releaseHistory.promise;
        await route.fulfill({ response });
      } catch {
        // The old request can be cancelled before its held response is released.
      } finally {
        historySettled.resolve();
      }
    }, { times: 1 });
  await page.getByRole("button", { name: "刷新历史记录" }).click();
  const oldHistory = await within(previousHistory.promise, "old history request did not reach Java");
  assert.equal(oldHistory.request.headers()["x-studio-account"], "lin");
  assert.equal(oldHistory.status, 200);
  assert.ok(oldHistory.body.items.some((task) => task.id === submittedId));
  const historyCancelled = deferred();
  page.on("requestfailed", (request) => {
    if (request === oldHistory.request) historyCancelled.resolve(request);
  });

  const secondTab = await context.newPage();
  await secondTab.goto("/history");
  await secondTab.getByRole("button", { name: "当前账号与切换" }).click();
  await secondTab.getByRole("button", { name: "切换账号", exact: true }).click();
  await secondTab.getByRole("button", { name: /切换到.*周野/ }).click();
  await page.locator(".avatar").filter({ hasText: /^周$/ }).waitFor();
  const emptyHistory = page.getByRole("heading", { name: "还没有制作记录" });
  await emptyHistory.waitFor();
  releaseHistory.resolve();
  await within(historySettled.promise, "old history route did not settle");
  const cancelled = await within(historyCancelled.promise, "old history request was not aborted");
  assert.match(cancelled.failure()?.errorText, /ABORTED/i);
  await result.waitFor({ state: "hidden" });
  assert.equal(await emptyHistory.isVisible(), true);
  assert.equal(await page.locator(".task-card").count(), 0);
  const stale = await page.request.get("/api/tasks/history", {
    headers: { "X-Studio-Account": "lin" },
  });
  assert.equal(stale.status(), 401);
  await secondTab.close();

  await page.goto("/templates/coast");
  let expiredId;
  for (let index = 0; index < 2; index++) {
    const uploaded = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/assets" && response.request().method() === "POST");
    await page.locator("input[type=file]").nth(index).setInputFiles({
      name: "coast-" + index + ".jpg", mimeType: "image/jpeg", buffer: bytes,
    });
    const response = await uploaded;
    assert.equal(response.status(), 201);
    if (index === 0) expiredId = (await response.json()).assetId;
    await page.getByRole("img", { name: "素材 " + (index + 1) + " 预览" }).waitFor();
  }
  const expiredPreview = page.getByRole("img", { name: "素材 1 预览" });
  await page.route("**/api/tasks", (route) => route.fulfill({
    status: 400, json: { message: "有素材已失效，请重新上传。", unavailableAssetIds: [expiredId] },
  }));
  await submit.press("Enter");
  await page.getByText("素材已失效，请重新上传。", { exact: true }).waitFor();
  assert.equal(await expiredPreview.count(), 0);
  assert.equal(await page.getByRole("img", { name: "素材 2 预览" }).count(), 1);
  assert.equal(await submit.isDisabled(), true);
  await page.locator("input[type=file]").first().setInputFiles({
    name: "replacement.jpg", mimeType: "image/jpeg", buffer: bytes,
  });
  await expiredPreview.waitFor();
  assert.equal(await submit.isEnabled(), true);

  await page.goto("/templates/garden");
  await requirements.waitFor();
  assert.equal(await requirements.innerText(), "素材要求 · 1 张图片 · PNG · 单张 ≤ 5 MB · 单张 ≤ 2400 万像素");
  const pngOnlyPicker = page.locator("input[type=file]");
  assert.equal(await pngOnlyPicker.getAttribute("accept"), "image/png,.png");
  const jpegFile = { name: "wrong.jpg", mimeType: "image/jpeg", buffer: bytes };
  await pngOnlyPicker.setInputFiles(jpegFile);
  await slot.getByRole("alert").getByText("请选择有效的 PNG 图片。").waitFor();
  assert.equal(await submit.isDisabled(), true);
  const rejectedByJava = await page.request.post("/api/assets", {
    headers: { "X-Studio-Request": "1" },
    multipart: { templateId: "garden", file: jpegFile },
  });
  assert.equal(rejectedByJava.status(), 400);
  assert.equal((await rejectedByJava.json()).message, "模板仅支持 PNG 图片。");

  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const pngFile = { name: "valid.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") };
  await pngOnlyPicker.setInputFiles(pngFile);
  await preview.waitFor();
  assert.equal(await submit.isEnabled(), true);

  const pendingAsset = deferred();
  const releaseAsset = deferred();
  held.push(releaseAsset);
  await page.route(assetContent, async (route) => {
    pendingAsset.resolve(route.request());
    await releaseAsset.promise;
    await route.continue().catch(() => {});
  }, { times: 1 });
  await pngOnlyPicker.setInputFiles(pngFile);
  const assetRequest = await within(pendingAsset.promise, "replacement preview did not reach the proxy");
  assert.equal(assetRequest.headers()["x-studio-account"], "zhou");
  const signedOut = await page.request.post("/api/session/logout", { headers: { "X-Studio-Request": "1" } });
  assert.equal(signedOut.status(), 204);
  const unauthorizedAsset = page.waitForResponse((response) => response.url() === assetRequest.url());
  releaseAsset.resolve();
  assert.equal((await unauthorizedAsset).status(), 401);
  await page.getByRole("button", { name: "使用周野", disabled: false }).waitFor();
  await preview.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".avatar").filter({ hasText: /^周$/ }).count(), 0);
  console.log("Guest requirements, upload caps and formats, keyboard focus, preview deadlines and session recovery verified.");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/templates");
  await page.locator(".template-card").last().waitFor();
  assert.equal(await page.locator(".template-grid").evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.split(" ").length), 6);
  const account = page.getByRole("button", { name: "当前账号与切换" });
  await account.click();
  await dialog.getByRole("tab", { name: "注册账号" }).click();
  await dialog.getByRole("textbox", { name: /用户名/ }).fill("browser-personal");
  await dialog.getByRole("textbox", { name: /显示名称/ }).fill("浏览器验收");
  await dialog.getByLabel(/密码/).fill("browser-private-26");
  await dialog.getByRole("button", { name: "注册并登录" }).click();
  await dialog.waitFor({ state: "hidden" });
  await account.getByText("浏览器验收").waitFor();
  await account.click();
  await dialog.getByRole("heading", { name: "账户设置" }).waitFor();
  await dialog.getByRole("link", { name: "我的制作" }).click();
  await page.getByRole("heading", { name: "还没有制作记录" }).waitFor();
  await page.goto("/templates/desert");
  await choose.waitFor();
  assert.equal(await page.locator(".workspace-grid").evaluate((grid) => {
    const [editor, history] = grid.children;
    return history.getBoundingClientRect().left >= editor.getBoundingClientRect().right;
  }), true);
  await page.locator("input[type=file]").setInputFiles({ name: "draft.jpg", mimeType: "image/jpeg", buffer: bytes });
  await preview.waitFor();
  await account.click();
  await dialog.getByRole("button", { name: "切换账号", exact: true }).click();
  await dialog.getByRole("textbox", { name: /用户名/ }).fill("browser-personal");
  await dialog.getByLabel(/密码/).fill("incorrect");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await dialog.getByText("账号或密码错误。").waitFor();
  await dialog.getByRole("tab", { name: "注册账号" }).click();
  await dialog.getByRole("textbox", { name: /显示名称/ }).waitFor();
  assert.equal(await dialog.getByText("账号或密码错误。").count(), 0);
  await page.keyboard.press("Escape");
  await preview.waitFor();
  assert.equal(await submit.isEnabled(), true);
  console.log("MUI desktop layout, browser registration, account settings and private history verified.");
} finally {
  for (const request of held) request.resolve();
  await browser.close();
}
