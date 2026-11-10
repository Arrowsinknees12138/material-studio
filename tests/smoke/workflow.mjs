import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ baseURL: "http://web:3000", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);

  await page.route("**/api/templates", (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto("/templates");
  await page.getByRole("alert").getByText("模板暂时无法加载").waitFor();
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByText("6 款模板", { exact: true }).waitFor();
  await page.getByRole("button", { name: "旅行风景" }).click();
  await page.getByText("2 款模板", { exact: true }).waitFor();
  assert.equal(await page.locator(".template-card").count(), 2);
  await page.getByRole("link", { name: /沙丘日记/ }).click();
  await page.getByRole("heading", { name: /沙丘日记/ }).waitFor();
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
    const task = await accepted.json();
    assert.equal(task.status, "QUEUED");
    return task.id;
  }

  ids.push(await submitTask());
  ids.push(await submitTask());
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
  const unattended = await submitTask();
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
  console.log("Catalog, consecutive submissions, query recovery, refresh, idle polling and closing the page verified.");
} finally {
  await browser.close();
}
