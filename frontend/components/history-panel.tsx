"use client";

/* eslint-disable @next/next/no-img-element -- Private images need the browser session cookie. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, stageLabels, type Task, type TaskStatus } from "../lib/api";
import { createTaskFeed, type TaskEntry } from "../lib/task-feed";

const labels: Record<TaskStatus, string> = {
  QUEUED: "等待处理",
  RUNNING: "处理中",
  SUCCEEDED: "制作成功",
  FAILED: "制作失败",
};

const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function useHistory(templateId?: string) {
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const feed = useRef<ReturnType<typeof createTaskFeed> | null>(null);

  useEffect(() => {
    const instance = createTaskFeed((id, signal) => api<Task>("/tasks/" + id, { signal }), setEntries);
    feed.current = instance;
    return () => { instance.dispose(); feed.current = null; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = templateId ? "?templateId=" + encodeURIComponent(templateId) : "";
    void api<Task[]>("/tasks" + query, { signal: controller.signal })
      .then((tasks) => { if (!controller.signal.aborted) feed.current?.add(tasks); })
      .catch((problem) => { if (!controller.signal.aborted) setError(errorMessage(problem)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, templateId]);

  return {
    entries, loading, error,
    accept: (task: Task) => feed.current?.add([task]),
    retry: (id: string) => feed.current?.retry(id),
    refresh: () => { setError(null); setLoading(true); setAttempt((value) => value + 1); },
  };
}

export function HistoryPanel({ history, full = false }: { history: ReturnType<typeof useHistory>; full?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<Task | null>(null);

  useEffect(() => {
    if (preview && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [preview]);

  return (
    <section className={full ? "panel history-panel full-history" : "panel history-panel"} aria-labelledby="history-heading">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">制作记录 / HISTORY</p>
          <h2 id="history-heading">{full ? "全部记录" : "当前模板记录"}</h2>
        </div>
        <button className="icon-button" aria-label="刷新历史记录" title="刷新历史记录"
          onClick={history.refresh} disabled={history.loading}>↻</button>
      </header>
      {history.error && <div className="notice" role="alert">
        {history.error} <button className="text-button" onClick={history.refresh}>重新加载</button>
      </div>}
      {history.loading && <p className="history-loading" role="status">正在读取制作记录…</p>}
      {!history.loading && !history.error && history.entries.length === 0 && (
        <div className="empty-box">
          <span className="empty-mark" aria-hidden="true">◫</span>
          <h3>还没有制作记录</h3>
          <p>提交后的任务和结果会显示在这里。</p>
          {full && <Link className="secondary-button" href="/templates">去挑模板</Link>}
        </div>
      )}
      {history.entries.length > 0 && (
        <div className="task-grid">
          {history.entries.map(({ task, queryError }) => (
            <article className="task-card" key={task.id}>
              {task.resultUrl ? (
                <button className="result-thumb" onClick={() => setPreview(task)} aria-label={"预览" + task.templateTitle + "的结果"}>
                  <img src={task.resultUrl} alt={task.templateTitle + "制作结果"} />
                  <span aria-hidden="true">↗</span>
                </button>
              ) : (
                <div className={"task-placeholder " + task.status.toLowerCase()} aria-hidden="true">
                  <span>{task.status === "FAILED" ? "!" : task.status === "RUNNING" ? "✳" : "◷"}</span>
                </div>
              )}
              <div className="task-copy">
                <span className={"status-pill " + task.status.toLowerCase()}>{labels[task.status]}</span>
                <h3>{task.templateTitle}</h3>
                <time dateTime={task.createdAt}>{dateFormat.format(new Date(task.createdAt))}</time>
                {task.stage && task.status !== "SUCCEEDED" && <p>{stageLabels[task.stage]}</p>}
                {task.errorMessage && <p className="task-error">{task.errorMessage}</p>}
                {queryError && <div className="query-error" role="status">
                  <p>暂时无法更新 · {queryError}</p>
                  <button className="text-button" onClick={() => history.retry(task.id)}>重新查询</button>
                </div>}
              </div>
            </article>
          ))}
        </div>
      )}
      <dialog className="preview-dialog" ref={dialog} aria-labelledby="preview-title" onClose={() => setPreview(null)}>
        {preview && (
          <>
            <header><h2 id="preview-title">{preview.templateTitle}</h2>
              <button className="icon-button" aria-label="关闭结果预览" onClick={() => dialog.current?.close()}>×</button></header>
            <img src={preview.resultUrl ?? ""} alt={preview.templateTitle + "制作结果"} />
          </>
        )}
      </dialog>
    </section>
  );
}
