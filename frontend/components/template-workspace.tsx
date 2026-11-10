"use client";

/* eslint-disable @next/next/no-img-element -- Uploaded previews use browser-created object URLs. */
import Link from "next/link";
import { ChevronLeft, UploadFileOutlined } from "@mui/icons-material";
import { Alert, Box, Button, CircularProgress, IconButton, Paper, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, errorMessage, jsonBody, type Asset, type Task, type Template } from "../lib/api";
import { loadImagePreview } from "../lib/image-preview";
import { hasAllowedImageType, imageAccept, imageFormatNames } from "../lib/image-upload";
import { HistoryPanel, useHistory } from "./history-panel";
import { AccountPrompt, useSession } from "./studio-shell";
import { TemplateCover } from "./template-cover";

type PreviewState = "loading" | "ready" | "failed";
type UploadedSlot = { state: "uploaded"; file: File; asset: Asset; preview: PreviewState; attempt: number };

type Slot =
  | { state: "uploading"; file: File }
  | { state: "error"; file: File; message: string }
  | UploadedSlot;

function UploadSlot({ index, slot, template, choose, remove, changePreview }: {
  index: number;
  slot?: Slot;
  template: Template;
  choose: (file: File) => void;
  remove: () => void;
  changePreview: (index: number, asset: Asset, attempt: number, state: PreviewState) => void;
}) {
  const { user } = useSession();
  const username = user?.username ?? "";
  const input = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const uploaded = slot?.state === "uploaded" ? slot : undefined;
  const asset = uploaded?.preview === "failed" ? undefined : uploaded?.asset;
  const attempt = uploaded?.attempt ?? 0;
  const [image, setImage] = useState<{ asset: Asset; attempt: number; src: string }>();
  const src = image && image.asset === asset && image.attempt === attempt ? image.src : undefined;

  useEffect(() => {
    if (!asset) return;
    const url = asset.previewUrl + (attempt ? "?attempt=" + attempt : "");
    return loadImagePreview(url, username, (src) => setImage({ asset, attempt, src }),
      () => changePreview(index, asset, attempt, "failed"));
  }, [asset, attempt, changePreview, index, username]);

  return (
    <Box className={"upload-slot" + (uploaded ? " uploaded" : "")}>
      <input className="sr-only" type="file" accept={imageAccept(template.acceptedMimeTypes)}
        aria-label={"选择第 " + (index + 1) + " 张图片"} tabIndex={-1} ref={input}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) choose(file);
        }} />
      {asset && src && (
        <img key={src} className="slot-preview" src={src}
          alt={"素材 " + (index + 1) + " 预览"} hidden={uploaded?.preview !== "ready"}
          onLoad={() => changePreview(index, asset, attempt, "ready")}
          onError={() => changePreview(index, asset, attempt, "failed")} />
      )}
      <Box className="slot-copy">
        {slot && <Typography variant="caption" color="text.secondary">素材 {String(index + 1).padStart(2, "0")}</Typography>}
        {slot?.state === "uploading" && <Typography variant="caption" role="status">正在上传…</Typography>}
        {slot && <Typography variant="body2" className="file-name" title={slot.file.name}>{slot.file.name}</Typography>}
        {slot?.state === "error" && <Typography variant="body2" color="error" role="alert">{slot.message}</Typography>}
        {uploaded?.preview === "loading" && <Typography variant="caption" role="status">正在加载素材预览…</Typography>}
        {uploaded?.preview === "failed" && <Typography variant="body2" color="error" role="alert">素材预览暂时无法加载。</Typography>}
        <Stack direction="row" spacing={0.5} useFlexGap className="slot-actions">
          <Button ref={chooseButton} type="button" size="small" color={slot ? "primary" : "inherit"}
            className={slot ? undefined : "upload-trigger"}
            aria-label={slot ? "替换素材 " + (index + 1) : "选择素材 " + (index + 1)}
            data-focus-after-login={index === 0 ? "" : undefined}
            onClick={() => input.current?.click()}>
            {!slot && <Box className="upload-icon"><UploadFileOutlined fontSize="small" /></Box>}
            {slot ? "替换" : "选择图片"}
          </Button>
          {slot?.state === "error" && <Button type="button" size="small"
            onClick={() => { chooseButton.current?.focus(); choose(slot.file); }}>重试上传</Button>}
          {uploaded?.preview === "failed" && <Button type="button" size="small"
            onClick={() => {
              chooseButton.current?.focus();
              changePreview(index, uploaded.asset, attempt, "loading");
            }}>重试预览</Button>}
          {slot && <Button type="button" size="small" aria-label={"移除素材 " + (index + 1)}
            onClick={() => { chooseButton.current?.focus(); remove(); }}>移除</Button>}
        </Stack>
      </Box>
    </Box>
  );
}

function createRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function CreationForm({ template, accept }: { template: Template; accept: (task: Task) => void }) {
  const { user } = useSession();
  const headers = { "X-Studio-Account": user?.username ?? "" };
  const [slots, setSlots] = useState<(Slot | undefined)[]>(() => Array(template.requiredImageCount).fill(undefined));
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const uploadRequests = useRef(new Map<number, AbortController>());
  const submitRequest = useRef<AbortController | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);

  useEffect(() => {
    const uploads = uploadRequests.current;
    return () => {
      uploads.forEach((controller) => controller.abort());
      uploads.clear();
      submitRequest.current?.abort();
    };
  }, []);

  function updateSlot(index: number, value?: Slot) {
    setSlots((current) => current.map((slot, position) => position === index ? value : slot));
  }

  const changePreview = useCallback((index: number, asset: Asset, attempt: number, preview: PreviewState) => {
    setSlots((current) => current.map((slot, position) =>
      position === index && slot?.state === "uploaded" && slot.asset === asset && slot.attempt === attempt
        && slot.preview === (preview === "loading" ? "failed" : "loading")
        ? { ...slot, preview, attempt: attempt + (preview === "loading" ? 1 : 0) }
        : slot));
  }, []);

  function remove(index: number) {
    uploadRequests.current.get(index)?.abort();
    uploadRequests.current.delete(index);
    updateSlot(index);
  }

  async function upload(index: number, file: File) {
    remove(index);
    setFeedback(null);
    if (file.size === 0 || file.size > template.maxFileSizeBytes) {
      updateSlot(index, { state: "error", file, message: "图片为空或超过模板大小上限。" });
      return;
    }
    const controller = new AbortController();
    uploadRequests.current.set(index, controller);
    updateSlot(index, { state: "uploading", file });
    try {
      const allowed = await hasAllowedImageType(file, template.acceptedMimeTypes);
      if (controller.signal.aborted) return;
      if (!allowed) {
        const formats = imageFormatNames(template.acceptedMimeTypes).join(" 或 ");
        updateSlot(index, { state: "error", file, message: "请选择有效的 " + formats + " 图片。" });
        return;
      }
      const form = new FormData();
      form.set("templateId", template.id);
      form.set("file", file);
      const asset = await api<Asset>("/assets", { method: "POST", headers, body: form, signal: controller.signal });
      if (uploadRequests.current.get(index) === controller) {
        updateSlot(index, { state: "uploaded", file, asset, preview: "loading", attempt: 0 });
      }
    } catch (error) {
      if (uploadRequests.current.get(index) === controller) {
        updateSlot(index, { state: "error", file, message: errorMessage(error) });
      }
    } finally {
      if (uploadRequests.current.get(index) === controller) uploadRequests.current.delete(index);
    }
  }

  const ready = slots.every((slot) => slot?.state === "uploaded" && slot.preview === "ready");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || submitRequest.current) return;
    const assetIds = slots.flatMap((slot) => slot?.state === "uploaded" ? [slot.asset.assetId] : []);
    const signature = assetIds.join(",");
    if (request.current?.signature !== signature) request.current = { signature, id: createRequestId() };
    const controller = new AbortController();
    submitRequest.current = controller;
    setSubmitting(true);
    setFeedback(null);
    try {
      const options = jsonBody({ templateId: template.id, assetIds, requestId: request.current.id }, controller.signal);
      const task = await api<Task>("/tasks", {
        ...options, headers: { ...headers, "Content-Type": "application/json" },
      });
      if (!controller.signal.aborted) {
        accept(task);
        request.current = null;
        setFeedback({ error: false, message: "任务已受理，可以在记录中查看进度。" });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.unavailableAssetIds.length) {
        const unavailable = new Set(error.unavailableAssetIds);
        setSlots((current) => current.map((slot) =>
          slot?.state === "uploaded" && unavailable.has(slot.asset.assetId)
            ? { state: "error", file: slot.file, message: "素材已失效，请重新上传。" }
            : slot,
        ));
      }
      setFeedback({ error: true, message: errorMessage(error) });
    } finally {
      submitRequest.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <Stack component="form" className="create-form" onSubmit={(event) => void submit(event)}>
      <Box component="fieldset" disabled={submitting} aria-describedby="template-image-requirements">
        <Typography component="legend" sx={{ fontWeight: 600 }}>上传素材</Typography>
        <Stack spacing={1} className={"upload-list" + (slots.length === 1 ? " single-slot" : "")}>
          {slots.map((slot, index) => (
            <UploadSlot key={index} index={index} template={template} slot={slot}
              choose={(file) => void upload(index, file)} remove={() => remove(index)}
              changePreview={changePreview} />
          ))}
        </Stack>
      </Box>
      <Box className="submit-area">
        <Button fullWidth variant="contained" disabled={!ready || submitting} type="submit">
          {submitting ? "正在提交…" : "提交制作"}
        </Button>
        {feedback && <Typography variant="caption" color={feedback.error ? "error" : "primary"}
          role={feedback.error ? "alert" : "status"}>{feedback.message}</Typography>}
      </Box>
    </Stack>
  );
}

function Cover({ template }: { template: Template }) {
  return (
    <>
      <Stack direction="row" spacing={0.5} className="workspace-title" sx={{ alignItems: "center" }}>
        <IconButton component={Link} href="/templates" aria-label="返回模板库"><ChevronLeft /></IconButton>
        <Typography component="h1" variant="subtitle1" sx={{ fontWeight: 700 }}>{template.title}</Typography>
      </Stack>
      <TemplateCover key={template.coverUrl} className="workspace-cover" url={template.coverUrl} title={template.title} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{template.description}</Typography>
      <Typography variant="caption" id="template-image-requirements" className="input-help" color="text.secondary">
        素材要求 · {template.requiredImageCount} 张图片 · {imageFormatNames(template.acceptedMimeTypes).join(" / ")}
        {" · 单张 ≤ "}{template.maxFileSizeBytes / 1024 ** 2} MB · 单张 ≤ {template.maxImagePixels / 10_000} 万像素
      </Typography>
    </>
  );
}

function LoggedInWorkspace({ template }: { template: Template }) {
  const history = useHistory(template.id);
  return (
    <Box className="workspace-grid">
      <Paper component="section" variant="outlined" className="panel editor-panel">
        <Cover template={template} />
        <CreationForm template={template} accept={history.accept} />
      </Paper>
      <HistoryPanel history={history} />
    </Box>
  );
}

export function TemplateWorkspace({ id }: { id: string }) {
  const { user } = useSession();
  const [template, setTemplate] = useState<Template | null>(null);
  const [error, setError] = useState<{ missing: boolean; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api<Template>("/templates/" + encodeURIComponent(id), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setTemplate(data); })
      .catch((problem) => {
        if (!controller.signal.aborted) {
          setError({ missing: problem instanceof ApiError && problem.status === 404, message: errorMessage(problem) });
        }
      });
    return () => controller.abort();
  }, [id, attempt]);

  return (
    <Box className="workspace-page">
      {error ? (
        <Alert severity="error" action={<Stack direction="row">
          <Button component={Link} href="/templates" color="inherit">返回模板库</Button>
          {!error.missing && <Button color="inherit"
            onClick={() => { setError(null); setAttempt((key) => key + 1); }}>重新加载</Button>}
        </Stack>}>
          <Typography component="h1" sx={{ fontWeight: 700 }}>{error.missing ? "找不到这个模板" : "模板暂时无法加载"}</Typography>
          {error.message}
        </Alert>
      ) : !template ? (
        <Stack role="status" className="empty-box" direction="row" spacing={1} sx={{ justifyContent: "center" }}>
          <CircularProgress size={16} /><Typography>正在加载模板详情…</Typography>
        </Stack>
      ) : user ? (
        <LoggedInWorkspace key={user.username} template={template} />
      ) : (
        <Box className="workspace-grid">
          <Paper component="section" variant="outlined" className="panel editor-panel"><Cover template={template} /></Paper>
          <AccountPrompt />
        </Box>
      )}
    </Box>
  );
}
