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
}

const held = [];
try {
  const image = await page.request.get("/demo/desert.jpg");
  assert.ok(image.ok());
  const bytes = await image.body();

  await page.goto("/templates/desert");
  await page.getByRole("button", { name: "使用林夏" }).press("Enter");
  const choose = page.getByRole("button", { name: "选择素材 1" });
  const replace = page.getByRole("button", { name: "替换素材 1" });
  const remove = page.getByRole("button", { name: "移除素材 1" });
  const preview = page.getByRole("img", { name: "素材 1 预览" });
  const submit = page.getByRole("button", { name: "提交制作" });
  const slot = page.locator(".upload-slot");
  await choose.waitFor();
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
  assert.match(current, /^\/api\/assets\//);
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

  await select(choose, "last.jpg");
  await preview.waitFor();
  await page.route(/\/api\/tasks\/[^/]+\/result(?:\?|$)/, (route) =>
    new URL(route.request().url()).searchParams.has("attempt") ? route.continue() : route.fulfill({ status: 503 }));
  const accepted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
  await submit.press("Enter");
  const submission = await accepted;
  assert.equal(submission.status(), 202, await submission.text());
  await page.getByText("任务已受理，可以在记录中查看进度。", { exact: true }).waitFor();
  const result = page.getByRole("button", { name: "预览沙丘日记的结果" }).first();
  await result.getByText("打开预览").waitFor({ timeout: 25000 });
  await result.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("alert").getByText("结果图片暂时无法加载。").waitFor();
  assert.equal(await page.getByText("制作成功", { exact: true }).count(), 1);
  await dialog.getByRole("button", { name: "重新加载图片" }).press("Enter");
  await dialog.getByRole("img", { name: "沙丘日记制作结果" }).waitFor();
  assert.ok(await dialog.locator("img").evaluate((img) => img.naturalWidth > 0));
  assert.equal(await dialog.getByRole("alert").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await result.evaluate((node) => node === document.activeElement), true);
  const secondTab = await context.newPage();
  await secondTab.goto("/history");
  await secondTab.locator("summary[aria-label='当前账号与切换']").click();
  await secondTab.getByRole("button", { name: /切换到.*周野/ }).click();
  await page.locator(".avatar").filter({ hasText: /^周$/ }).waitFor();
  await result.waitFor({ state: "hidden" });
  const stale = await page.request.get("/api/tasks/history", {
    headers: { "X-Studio-Account": "lin" },
  });
  assert.equal(stale.status(), 401);
  await secondTab.close();

  await page.goto("/templates/coast");
  for (let index = 0; index < 2; index++) {
    await page.locator("input[type=file]").nth(index).setInputFiles({
      name: "coast-" + index + ".jpg", mimeType: "image/jpeg", buffer: bytes,
    });
    await page.getByRole("img", { name: "素材 " + (index + 1) + " 预览" }).waitFor();
  }
  const expiredPreview = page.getByRole("img", { name: "素材 1 预览" });
  const expiredId = (await expiredPreview.getAttribute("src")).split("/")[3];
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
  console.log("320px keyboard, file signature, upload races, cross-tab session, expired slots and result retry verified.");
} finally {
  for (const request of held) request.resolve();
  await browser.close();
}
