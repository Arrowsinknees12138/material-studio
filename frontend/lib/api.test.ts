import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Task } from "./api";
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
      .mockResolvedValueOnce(Response.json(finished));
    vi.stubGlobal("fetch", fetchMock);

    let entries: TaskEntry[] = [];
    const feed = createTaskFeed((id, signal) => api<Task>("/tasks/" + id, { signal }),
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
