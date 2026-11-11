"use client";

/* eslint-disable @next/next/no-img-element -- Private images need the browser session cookie. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Close, History, OpenInFull, Refresh } from "@mui/icons-material";
import { Alert, Box, Button, ButtonBase, Card, Dialog, DialogContent, DialogTitle, IconButton, Paper, Stack, Typography } from "@mui/material";
import { ApiError, api, errorMessage, stageLabels, type Task, type TaskPage, type TaskStatus } from "../lib/api";
import { loadImagePreview } from "../lib/image-preview";
import { createTaskFeed, type TaskEntry } from "../lib/task-feed";
import { useSession } from "./studio-shell";

const labels: Record<TaskStatus, string> = {
  QUEUED: "等待处理",
  RUNNING: "处理中",
  SUCCEEDED: "制作成功",
  FAILED: "制作失败",
};

const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const taskAcceptedKey = "studio:task-accepted";

export function useHistory(templateId?: string) {
  const { user } = useSession();
  const username = user?.username ?? "";
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 });
  const [scan, setScan] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const loadedMore = useRef(false);
  const firstPageIds = useRef(new Set<string>());
  const feed = useRef<ReturnType<typeof createTaskFeed> | null>(null);
  const readingHistory = useRef(true);
  const refreshPending = useRef(false);

  const load = useCallback((cursor: string | null) => {
    readingHistory.current = true;
    setError(null);
    setLoading(true);
    setRequest((current) => ({ cursor, attempt: current.attempt + 1 }));
  }, []);

  const refreshTracking = useCallback(() => {
    setTrackingError(null);
    setScan((value) => value + 1);
  }, []);

  const refresh = useCallback(() => {
    load(null);
    refreshTracking();
  }, [load, refreshTracking]);

  useEffect(() => {
    const instance = createTaskFeed((ids, signal) => {
      const query = new URLSearchParams({ ids: ids.join(",") });
      return api<Task[]>("/tasks/updates?" + query, { signal, headers: { "X-Studio-Account": username } });
    }, setEntries);
    feed.current = instance;
    return () => { instance.dispose(); feed.current = null; };
  }, [username]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (templateId) query.set("templateId", templateId);
    if (request.cursor) query.set("cursor", request.cursor);
    void api<TaskPage>("/tasks/history?" + query, {
      signal: controller.signal, headers: { "X-Studio-Account": username },
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        feed.current?.add(page.items);
        if (request.cursor) {
          loadedMore.current = true;
          setNextCursor(page.nextCursor);
        } else {
          const overlaps = page.items.some((task) => firstPageIds.current.has(task.id));
          // A full page of new tasks can leave a gap before the previously loaded records.
          if (!loadedMore.current || !overlaps) setNextCursor(page.nextCursor);
          firstPageIds.current = new Set(page.items.map((task) => task.id));
        }
      })
      .catch((problem) => { if (!controller.signal.aborted) setError(errorMessage(problem)); })
      .finally(() => {
        if (controller.signal.aborted) return;
        if (refreshPending.current) {
          refreshPending.current = false;
          refresh();
        } else {
          readingHistory.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [refresh, request, templateId, username]);

  useEffect(() => {
    const controller = new AbortController();
    async function findActive() {
      const query = new URLSearchParams({ active: "true", limit: "50" });
      if (templateId) query.set("templateId", templateId);
      let cursor: string | null = null;
      do {
        if (cursor) query.set("cursor", cursor);
        const page = await api<TaskPage>("/tasks/history?" + query, {
          signal: controller.signal, headers: { "X-Studio-Account": username },
        });
        if (controller.signal.aborted) return;
        feed.current?.add(page.items, false);
        cursor = page.nextCursor;
      } while (cursor);
    }

    void findActive().catch((problem) => {
      if (!controller.signal.aborted) setTrackingError(errorMessage(problem));
    });
    return () => controller.abort();
  }, [scan, templateId, username]);

  useEffect(() => {
    function refreshAfterChange() {
      if (readingHistory.current) refreshPending.current = true;
      else refresh();
    }

    function onStorage(event: StorageEvent) {
      if (event.key === taskAcceptedKey && event.newValue) refreshAfterChange();
    }

    window.addEventListener("focus", refreshAfterChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", refreshAfterChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  function accept(task: Task) {
    feed.current?.add([task]);
    try {
      // Each tab re-reads its own history with its current session.
      localStorage.setItem(taskAcceptedKey, crypto.getRandomValues(new Uint32Array(2)).join("-"));
    } catch {
      // Returning focus also refreshes history when storage is unavailable.
    }
  }

  return {
    entries, loading, error, trackingError, nextCursor, refreshTracking,
    accept,
    retry: (id: string) => feed.current?.retry(id),
    retryPage: () => load(request.cursor),
    loadMore: () => { if (nextCursor) load(nextCursor); },
    refresh,
  };
}

function ResultThumbnail({ url, title, retryRevision, open }: {
  url: string; title: string; retryRevision: number; open: () => void;
}) {
  const [failedRevision, setFailedRevision] = useState<number | null>(null);
  return (
    <ButtonBase className="result-thumb" onClick={open} aria-label={"预览" + title + "的结果"}>
      {failedRevision === retryRevision ? "打开预览"
        : <img src={url} alt="" onError={() => setFailedRevision(retryRevision)} />}
      <OpenInFull className="expand-result" fontSize="small" />
    </ButtonBase>
  );
}

type ResultImage =
  | { state: "loading"; src?: string }
  | { state: "ready"; src: string }
  | { state: "failed"; message: string };

const resultPreviewError = "结果图片暂时无法加载。";

function ResultPreview({ url, title, focusClose, onLoaded }: {
  url: string; title: string; focusClose: () => void; onLoaded: (url: string) => void;
}) {
  const { user } = useSession();
  const username = user?.username ?? "";
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<ResultImage>({ state: "loading" });

  useEffect(() => loadImagePreview(attempt ? url + "?attempt=" + attempt : url, username,
    (src) => setImage({ state: "loading", src }),
    (error) => {
      const message = error instanceof ApiError && (error.status === 0 || error.status === 401)
        ? error.message : resultPreviewError;
      setImage({ state: "failed", message });
    }), [attempt, url, username]);

  if (image.state === "failed") {
    return (
      <Stack className="empty-box" spacing={1} sx={{ alignItems: "center" }}>
        <Alert severity="error">{image.message}</Alert>
        <Button variant="outlined" onClick={() => {
          focusClose();
          setAttempt((current) => current + 1);
          setImage({ state: "loading" });
        }}>重新加载图片</Button>
      </Stack>
    );
  }
  const src = image.src;
  return (
    <>
      {image.state === "loading" && <Typography className="empty-box" role="status">正在加载结果图片…</Typography>}
      {src && <img src={src} alt={title + "制作结果"} hidden={image.state !== "ready"}
        onLoad={() => { setImage({ state: "ready", src }); onLoaded(url); }}
        onError={() => setImage({ state: "failed", message: resultPreviewError })} />}
    </>
  );
}

export function HistoryPanel({ history, full = false }: { history: ReturnType<typeof useHistory>; full?: boolean }) {
  const closePreview = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [loadedPreviews, setLoadedPreviews] = useState<Record<string, number>>({});

  function retryPreviewThumbnail(url: string) {
    setLoadedPreviews((current) => ({ ...current, [url]: (current[url] ?? 0) + 1 }));
  }

  return (
    <Paper component="section" variant="outlined" className="panel history-panel" aria-labelledby="history-heading">
      <Stack component="header" className="panel-heading" direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography component="h2" variant="subtitle1" id="history-heading">
          {full ? "全部记录" : "当前模板记录"}
        </Typography>
        <IconButton aria-label="刷新历史记录" title="刷新历史记录" size="small"
          onClick={() => { setRefreshCount((current) => current + 1); history.refresh(); }}
          disabled={history.loading}><Refresh fontSize="small" /></IconButton>
      </Stack>
      {history.error && <Alert severity="warning"
        action={<Button size="small" onClick={history.retryPage}>重新加载</Button>}>{history.error}</Alert>}
      {history.trackingError && <Alert severity="warning"
        action={<Button size="small" onClick={history.refreshTracking}>重试跟踪</Button>}>
        暂时无法恢复进行中的任务 · {history.trackingError}
      </Alert>}
      {history.loading && <Typography className="empty-box" role="status">正在读取制作记录…</Typography>}
      {!history.loading && !history.error && history.entries.length === 0 && (
        <Stack className="empty-box" spacing={1} sx={{ alignItems: "center" }}>
          <History fontSize="large" color="action" />
          <Typography component="h3" variant="subtitle1">还没有制作记录</Typography>
          <Typography variant="body2" color="text.secondary">提交后的任务和结果会显示在这里。</Typography>
          {full && <Button component={Link} href="/templates" variant="outlined">去挑模板</Button>}
        </Stack>
      )}
      {history.entries.length > 0 && (
        <Box className="task-grid">
          {history.entries.map(({ task, queryError }) => {
            const url = task.resultUrl;
            return (
              <Card component="article" variant="outlined" className="task-card" key={task.id}>
                {url ? (
                  <ResultThumbnail url={url} title={task.templateTitle} retryRevision={refreshCount + (loadedPreviews[url] ?? 0)}
                    open={() => setPreview({ url, title: task.templateTitle })} />
                ) : (
                  <Stack className="task-stage" spacing={0.75} sx={{ alignItems: "center", justifyContent: "center" }}>
                    <Typography variant="body2">{labels[task.status]}</Typography>
                    {task.stage && <Typography variant="caption" color="text.secondary">{stageLabels[task.stage]}</Typography>}
                    {task.errorMessage && <Typography variant="caption" color="error.light">{task.errorMessage}</Typography>}
                  </Stack>
                )}
                <Stack className="task-copy" spacing={0.5}>
                  {url && <Typography variant="caption" color="success.light">{labels[task.status]}</Typography>}
                  <Typography component="h3" variant="body2">{task.templateTitle}</Typography>
                  <Typography component="time" variant="caption" dateTime={task.createdAt} color="text.secondary">
                    {dateFormat.format(new Date(task.createdAt))}
                  </Typography>
                  {queryError && <Stack sx={{ alignItems: "flex-start" }} role="status">
                    <Typography variant="caption" color="warning.light">暂时无法更新 · {queryError}</Typography>
                    <Button size="small" onClick={() => history.retry(task.id)}>重新查询</Button>
                  </Stack>}
                </Stack>
              </Card>
            );
          })}
        </Box>
      )}
      {history.nextCursor && <Box sx={{ mt: 2 }}>
        <Button variant="outlined" onClick={history.loadMore} disabled={history.loading}>加载更多记录</Button>
      </Box>}
      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} fullWidth maxWidth="md"
        aria-labelledby="preview-title" slotProps={{ paper: { className: "preview-dialog" } }}>
        {preview && (
          <>
            <DialogTitle id="preview-title" className="dialog-heading">
              {preview.title}
              <IconButton ref={closePreview} aria-label="关闭结果预览" onClick={() => setPreview(null)}><Close /></IconButton>
            </DialogTitle>
            <DialogContent>
              <ResultPreview url={preview.url} title={preview.title} onLoaded={retryPreviewThumbnail}
                focusClose={() => closePreview.current?.focus()} />
            </DialogContent>
          </>
        )}
      </Dialog>
    </Paper>
  );
}
