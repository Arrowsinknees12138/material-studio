import { afterEach, describe, expect, it, vi } from "vitest";
import { api, fetchImage, jsonBody, sessionCheckEvent, type Task } from "./api";
import { createTaskFeed, type TaskEntry } from "./task-feed";

describe("task request deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a stalled body read, preserves the stage, and accepts a manual retry", async () => {
    vi.useFakeTimers();
    const active: Task = {
      id: "task", templateId: "moon", templateTitle: "月面来信",
      status: "RUNNING", stage: "GENERATE", createdAt: "2026-01-01T00:00:00Z",
      completedAt: null, resultUrl: null, errorMessage: null,
    };
    const finished = { ...active, status: "SUCCEEDED", stage: "FINALIZE" };
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_url, options) => {
        const signal = options?.signal;
        return new Response(new ReadableStream({
          start(stream) {
            signal?.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          },
        }));
      })
      .mockResolvedValueOnce(Response.json([finished]));
    vi.stubGlobal("fetch", fetchMock);

    let entries: TaskEntry[] = [];
    const feed = createTaskFeed((ids, signal) => api<Task[]>("/tasks/updates?ids=" + ids.join(","), { signal }),
      (value) => { entries = value; }, 50);
    feed.add([active]);

    await vi.advanceTimersByTimeAsync(8050);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(entries[0]).toEqual({ task: active, queryError: "请求超时，请重试。" });

    feed.retry(active.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(entries[0]).toEqual({ task: finished, queryError: null });
    feed.dispose();
  });
});

describe("API request contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("attaches the write marker and preserves the selected account and structured slot error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      message: "素材已失效。", unavailableAssetIds: ["expired", null, 42],
    }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { templateId: "moon", assetIds: ["expired"], requestId: "request-1" };
    const options = jsonBody(body);
    const headers = new Headers(options.headers);
    headers.set("X-Studio-Account", "lin");

    await expect(api("/tasks", { ...options, headers })).rejects.toMatchObject({
      status: 400, message: "素材已失效。", unavailableAssetIds: ["expired"],
    });
    const [url, sent] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tasks");
    expect(sent).toMatchObject({ method: "POST", body: JSON.stringify(body), cache: "no-store" });
    const sentHeaders = new Headers(sent?.headers);
    expect(sentHeaders.get("content-type")).toBe("application/json");
    expect(sentHeaders.get("x-studio-request")).toBe("1");
    expect(sentHeaders.get("x-studio-account")).toBe("lin");
  });

  it("requests a session check for an unauthorized private read but not for a failed login", async () => {
    const target = new EventTarget();
    const check = vi.fn();
    target.addEventListener(sessionCheckEvent, check);
    vi.stubGlobal("window", target);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "账号已切换，请重试。" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ message: "账号或密码错误。" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/tasks/history")).rejects.toMatchObject({ status: 401 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("x-studio-request")).toBe(false);
    await expect(api("/session", jsonBody({ username: "lin", password: "bad" })))
      .rejects.toMatchObject({ status: 401 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("preserves caller cancellation and clears the request timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const cancelled = new DOMException("Account changed", "AbortError");
    const result = api("/tasks/history", { signal: controller.signal });
    controller.abort(cancelled);

    await expect(result).rejects.toBe(cancelled);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns no payload for logout and normalizes non-JSON service errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 })));

    await expect(api("/session/logout", { method: "POST" })).resolves.toBeUndefined();
    await expect(api("/templates")).rejects.toMatchObject({ status: 502, message: "请求失败，请重试。" });
  });

  it("reads private result bytes and forwards the selected account", async () => {
    const url = "/api/tasks/task-1/result";
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    const image = await fetchImage(url, { headers: { "X-Studio-Account": "lin" } });

    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    const [sentUrl, sent] = fetchMock.mock.calls[0];
    expect(sentUrl).toBe(url);
    expect(sent?.cache).toBe("no-store");
    expect(new Headers(sent?.headers).get("x-studio-account")).toBe("lin");
  });

  it("times out a stalled result body after the response headers arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      return new Response(new ReadableStream({
        start(stream) {
          signal?.addEventListener("abort", () => stream.error(signal.reason), { once: true });
        },
      }), { headers: { "Content-Type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const failure = expect(fetchImage("/api/tasks/task-1/result"))
      .rejects.toMatchObject({ status: 0, message: "请求超时，请重试。" });

    await vi.advanceTimersByTimeAsync(8000);
    await failure;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the session for an unauthorized result request and ignores cancelled responses", async () => {
    const target = new EventTarget();
    const check = vi.fn();
    target.addEventListener(sessionCheckEvent, check);
    vi.stubGlobal("window", target);
    const pending = Promise.withResolvers<Response>();
    const expired = () => Response.json({ message: "请先登录演示账号。" }, { status: 401 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(expired())
      .mockReturnValueOnce(pending.promise));
    const url = "/api/tasks/task-1/result";

    await expect(fetchImage(url)).rejects.toMatchObject({ status: 401, message: "请先登录演示账号。" });
    expect(check).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const result = fetchImage(url, { signal: controller.signal });
    controller.abort();
    pending.resolve(expired());
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
