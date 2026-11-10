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

describe("task feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches tasks, keeps each status independent, and retries only an active task", async () => {
    let entries: TaskEntry[] = [];
    const read = vi.fn<(ids: string[], signal: AbortSignal) => Promise<Task[]>>()
      .mockResolvedValueOnce([task("b", "FAILED")])
      .mockResolvedValueOnce([{ ...task("a", "SUCCEEDED"), resultUrl: "/api/tasks/a/result" }]);
    const feed = createTaskFeed(read, (value) => { entries = value; }, 50);
    feed.add([task("a"), task("b", "QUEUED")]);
    await vi.advanceTimersByTimeAsync(50);

    expect(entries.find(({ task }) => task.id === "a")).toMatchObject({
      task: { status: "RUNNING", stage: "GENERATE" }, queryError: "暂时无法读取该任务。",
    });
    expect(entries.find(({ task }) => task.id === "b")).toMatchObject({
      task: { status: "FAILED", errorMessage: "模拟失败" }, queryError: null,
    });

    feed.retry("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(entries.find(({ task }) => task.id === "a")).toMatchObject({
      task: { status: "SUCCEEDED", resultUrl: "/api/tasks/a/result" }, queryError: null,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(read.mock.calls.map(([ids]) => ids)).toEqual([["a", "b"], ["a"]]);
  });

  it("tracks off-page tasks in bounded batches and shows their latest status when loaded", async () => {
    const read = vi.fn(async (ids: string[]) => ids.map((id) => task(id, "SUCCEEDED")));
    const onChange = vi.fn();
    const feed = createTaskFeed(read, onChange, 50);
    const older = Array.from({ length: 50 }, (_, index) => task("old-" + index));
    feed.add([task("visible")]);
    feed.add(older, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([50, 1]);
    expect(onChange.mock.lastCall?.[0].map(({ task }: TaskEntry) => task.id)).toEqual(["visible"]);

    feed.add([older[0]]);
    expect(onChange.mock.lastCall?.[0].find(({ task }: TaskEntry) => task.id === "old-0")?.task.status)
      .toBe("SUCCEEDED");
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("aborts in-flight reads and ignores late responses after disposal", async () => {
    let complete!: (tasks: Task[]) => void;
    const response = new Promise<Task[]>((resolve) => { complete = resolve; });
    const read = vi.fn<(ids: string[], signal: AbortSignal) => Promise<Task[]>>(() => response);
    const onChange = vi.fn();
    const feed = createTaskFeed(read, onChange, 50);
    feed.add([task("old")]);
    await vi.advanceTimersByTimeAsync(50);
    feed.dispose();

    expect(read.mock.calls[0][1].aborted).toBe(true);
    complete([task("old", "SUCCEEDED")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
