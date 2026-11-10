import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./api";
import { createTaskFeed, type TaskEntry } from "./task-feed";

function task(id: string, status: Task["status"] = "RUNNING"): Task {
  return {
    id, status, stage: status === "QUEUED" ? null : "GENERATE",
    templateId: "coast", templateTitle: "海岸明信片", createdAt: "2026-01-01T00:00:00Z",
    completedAt: null, resultUrl: null, errorMessage: status === "FAILED" ? "模拟失败" : null,
  };
}

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("task feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps responses and query errors isolated across concurrent tasks", async () => {
    let entries: TaskEntry[] = [];
    const a = pending<Task>();
    const b = pending<Task>();
    const read = vi.fn((id: string) => id === "a" ? a.promise : b.promise);
    const feed = createTaskFeed(read, (value) => { entries = value; }, 50);
    feed.add([task("a"), task("b", "QUEUED")]);
    await vi.advanceTimersByTimeAsync(50);

    b.resolve(task("b", "FAILED"));
    a.reject(new Error("网络断开"));
    await vi.advanceTimersByTimeAsync(0);

    expect(entries.find(({ task }) => task.id === "a")).toMatchObject({
      task: { status: "RUNNING", stage: "GENERATE" }, queryError: "网络断开",
    });
    expect(entries.find(({ task }) => task.id === "b")).toMatchObject({
      task: { status: "FAILED", errorMessage: "模拟失败" }, queryError: null,
    });

    read.mockResolvedValueOnce({ ...task("a", "SUCCEEDED"), resultUrl: "/api/tasks/a/result" });
    feed.retry("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(entries.find(({ task }) => task.id === "a")).toMatchObject({
      task: { status: "SUCCEEDED", resultUrl: "/api/tasks/a/result" }, queryError: null,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual(["a", "a", "b"]);
  });

  it("aborts in-flight reads and ignores late responses after disposal", async () => {
    const response = pending<Task>();
    const read = vi.fn<(id: string, signal: AbortSignal) => Promise<Task>>(() => response.promise);
    const onChange = vi.fn();
    const feed = createTaskFeed(read, onChange, 50);
    feed.add([task("old")]);
    await vi.advanceTimersByTimeAsync(50);
    feed.dispose();

    expect(read.mock.calls[0][1].aborted).toBe(true);
    response.resolve(task("old", "SUCCEEDED"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not regress when an older history snapshot arrives", async () => {
    const onChange = vi.fn();
    const feed = createTaskFeed(async () => task("a", "SUCCEEDED"), onChange, 50);
    feed.add([task("a")]);
    await vi.advanceTimersByTimeAsync(50);
    feed.add([task("a", "QUEUED")]);
    expect(onChange.mock.lastCall?.[0][0].task.status).toBe("SUCCEEDED");
  });
});
