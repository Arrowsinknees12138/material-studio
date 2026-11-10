import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const baseURL = "http://web:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ baseURL, viewport: { width: 320, height: 740 } });
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
  const accepted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
  await submit.press("Enter");
  const submission = await accepted;
  assert.equal(submission.status(), 202, await submission.text());
  await page.getByText("任务已受理，可以在记录中查看进度。", { exact: true }).waitFor();
  const result = page.getByRole("button", { name: "预览沙丘日记的结果" }).first();
  await result.waitFor({ timeout: 25000 });
  await result.press("Enter");
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await result.evaluate((node) => node === document.activeElement), true);
  console.log("320px keyboard, file signature, upload races and result dialog verified.");
} finally {
  for (const request of held) request.resolve();
  await browser.close();
}
