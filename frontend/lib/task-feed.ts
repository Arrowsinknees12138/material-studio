import type { Task, TaskStage } from "./api";

export interface TaskEntry {
  task: Task;
  queryError: string | null;
}

type ReadTasks = (ids: string[], signal: AbortSignal) => Promise<Task[]>;

const stages: TaskStage[] = ["CHECK_INPUTS", "GENERATE", "FINALIZE"];
const batchSize = 50;

function isActive(task: Task): boolean {
  return task.status === "QUEUED" || task.status === "RUNNING";
}

function order(task: Task): number {
  if (task.status === "QUEUED") return 0;
  if (!isActive(task)) return 5;
  return task.stage ? stages.indexOf(task.stage) + 2 : 1;
}

export function createTaskFeed(read: ReadTasks, onChange: (entries: TaskEntry[]) => void, interval = 2000) {
  const entries = new Map<string, TaskEntry>();
  const visible = new Set<string>();
  const active = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let disposed = false;

  function publish() {
    onChange(Array.from(visible, (id) => entries.get(id)!).sort((a, b) =>
      Date.parse(b.task.createdAt) - Date.parse(a.task.createdAt) || b.task.id.localeCompare(a.task.id),
    ));
  }

  function schedule() {
    if (!active.size) {
      clearTimeout(timer);
      timer = undefined;
    } else if (!disposed && !request && timer === undefined) {
      timer = setTimeout(() => void poll([...active]), interval);
    }
  }

  function merge(task: Task) {
    const entry = entries.get(task.id);
    if (entry && (!isActive(entry.task) || order(task) < order(entry.task))) return;
    entries.set(task.id, { task, queryError: null });
    if (isActive(task)) active.add(task.id);
    else active.delete(task.id);
  }

  function setQueryError(id: string, message: string) {
    const entry = entries.get(id);
    if (entry && active.has(id)) entries.set(id, { ...entry, queryError: message });
  }

  async function poll(ids: string[]) {
    if (disposed || request || !ids.length) return;
    clearTimeout(timer);
    timer = undefined;
    const controller = new AbortController();
    request = controller;
    try {
      for (let offset = 0; offset < ids.length && !controller.signal.aborted; offset += batchSize) {
        const batch = ids.slice(offset, offset + batchSize).filter((id) => active.has(id));
        if (!batch.length) continue;
        try {
          const updates = await read(batch, controller.signal);
          if (controller.signal.aborted) return;
          const byId = new Map(updates.map((task) => [task.id, task]));
          for (const id of batch) {
            const update = byId.get(id);
            if (update) merge(update);
            else setQueryError(id, "暂时无法读取该任务。");
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : "查询暂时不可用。";
          batch.forEach((id) => setQueryError(id, message));
        }
        publish();
      }
    } finally {
      request = undefined;
      schedule();
    }
  }

  return {
    add(tasks: Task[], show = true) {
      if (disposed) return;
      tasks.forEach((task) => {
        merge(task);
        if (show) visible.add(task.id);
      });
      publish();
      schedule();
    },
    retry(id: string) {
      if (active.has(id)) void poll([id]);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      request?.abort();
    },
  };
}
