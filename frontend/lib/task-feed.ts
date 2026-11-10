import type { Task, TaskStage } from "./api";

export interface TaskEntry {
  task: Task;
  queryError: string | null;
}

type ReadTask = (id: string, signal: AbortSignal) => Promise<Task>;
type Poll = { timer?: ReturnType<typeof setTimeout>; controller?: AbortController };

const stages: TaskStage[] = ["CHECK_INPUTS", "GENERATE", "FINALIZE"];

export function isActive(task: Task): boolean {
  return task.status === "QUEUED" || task.status === "RUNNING";
}

function order(task: Task): number {
  if (task.status === "QUEUED") return 0;
  if (!isActive(task)) return 5;
  return task.stage ? stages.indexOf(task.stage) + 2 : 1;
}

export function createTaskFeed(read: ReadTask, onChange: (entries: TaskEntry[]) => void, interval = 2000) {
  const entries = new Map<string, TaskEntry>();
  const polls = new Map<string, Poll>();
  let disposed = false;

  function publish() {
    onChange(Array.from(entries.values()).sort((a, b) =>
      b.task.createdAt.localeCompare(a.task.createdAt) || b.task.id.localeCompare(a.task.id),
    ));
  }

  function schedule(id: string) {
    const entry = entries.get(id);
    if (disposed || !entry || !isActive(entry.task) || polls.has(id)) return;
    polls.set(id, { timer: setTimeout(() => void poll(id), interval) });
  }

  function merge(task: Task) {
    const entry = entries.get(task.id);
    if (entry && (!isActive(entry.task) || order(task) < order(entry.task))) return;
    entries.set(task.id, { task, queryError: null });
    if (!isActive(task)) {
      stop(task.id);
    } else {
      schedule(task.id);
    }
  }

  function stop(id: string) {
    const pending = polls.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller?.abort();
      polls.delete(id);
    }
  }

  async function poll(id: string) {
    const entry = entries.get(id);
    if (disposed || !entry || !isActive(entry.task) || polls.get(id)?.controller) return;
    stop(id);
    const controller = new AbortController();
    polls.set(id, { controller });

    try {
      const task = await read(id, controller.signal);
      if (disposed || controller.signal.aborted || task.id !== id) return;
      merge(task);
      publish();
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      const current = entries.get(id);
      if (current) {
        entries.set(id, {
          ...current,
          queryError: error instanceof Error ? error.message : "查询暂时不可用。",
        });
        publish();
      }
    } finally {
      if (polls.get(id)?.controller === controller) polls.delete(id);
      schedule(id);
    }
  }

  return {
    add(tasks: Task[]) {
      if (disposed) return;
      tasks.forEach(merge);
      publish();
    },
    retry(id: string) {
      void poll(id);
    },
    dispose() {
      disposed = true;
      polls.forEach((_, id) => stop(id));
    },
  };
}
