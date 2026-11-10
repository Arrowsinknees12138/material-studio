"use client";

/* eslint-disable @next/next/no-img-element -- Uploaded previews use the Java session cookie. */
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, errorMessage, jsonBody, type Asset, type Task, type Template } from "../lib/api";
import { hasAllowedImageType, imageAccept } from "../lib/image-upload";
import { HistoryPanel, useHistory } from "./history-panel";
import { AccountPrompt, useSession } from "./studio-shell";

type Slot =
  | { state: "uploading"; file: File }
  | { state: "error"; file: File; message: string }
  | { state: "ready"; file: File; asset: Asset };

function UploadSlot({ index, slot, template, choose, remove }: {
  index: number;
  slot?: Slot;
  template: Template;
  choose: (file: File) => void;
  remove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  return (
    <div className={"upload-slot" + (slot?.state === "ready" ? " uploaded" : "")}>
      <input className="sr-only" type="file" accept={imageAccept(template.acceptedMimeTypes)}
        aria-label={"选择第 " + (index + 1) + " 张图片"} tabIndex={-1} ref={input}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) choose(file);
        }} />
      {slot?.state === "ready" && <img className="slot-preview" src={slot.asset.previewUrl} alt={"素材 " + (index + 1) + " 预览"} />}
      <div className="slot-copy">
        <span className="slot-number">素材 {String(index + 1).padStart(2, "0")}</span>
        {!slot && <span className="slot-mark" aria-hidden="true">＋</span>}
        {slot?.state === "uploading" && <span className="slot-status" role="status">正在上传…</span>}
        {slot && <span className="file-name" title={slot.file.name}>{slot.file.name}</span>}
        {slot?.state === "error" && <p className="task-error" role="alert">{slot.message}</p>}
        <div className="slot-actions">
          <button ref={chooseButton} type="button" className={slot ? "text-button" : "upload-trigger"}
            aria-label={slot ? "替换素材 " + (index + 1) : "选择素材 " + (index + 1)}
            onClick={() => input.current?.click()}>{slot ? "替换" : "选择图片"}</button>
          {slot?.state === "error" && <button type="button" className="text-button"
            onClick={() => { chooseButton.current?.focus(); choose(slot.file); }}>重试上传</button>}
          {slot && <button type="button" className="text-button" aria-label={"移除素材 " + (index + 1)}
            onClick={() => { chooseButton.current?.focus(); remove(); }}>移除</button>}
        </div>
      </div>
    </div>
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

  function remove(index: number) {
    uploadRequests.current.get(index)?.abort();
    uploadRequests.current.delete(index);
    updateSlot(index);
  }

  async function upload(index: number, file: File) {
    remove(index);
    setFeedback(null);
    if (file.size === 0 || file.size > template.maxFileSizeBytes) {
      updateSlot(index, { state: "error", file, message: "请选择大小符合要求的 JPEG 或 PNG 图片。" });
      return;
    }
    const controller = new AbortController();
    uploadRequests.current.set(index, controller);
    updateSlot(index, { state: "uploading", file });
    try {
      const allowed = await hasAllowedImageType(file, template.acceptedMimeTypes);
      if (controller.signal.aborted) return;
      if (!allowed) {
        updateSlot(index, { state: "error", file, message: "请选择有效的 JPEG 或 PNG 图片。" });
        return;
      }
      const form = new FormData();
      form.set("templateId", template.id);
      form.set("file", file);
      const asset = await api<Asset>("/assets", { method: "POST", headers, body: form, signal: controller.signal });
      if (uploadRequests.current.get(index) === controller) updateSlot(index, { state: "ready", file, asset });
    } catch (error) {
      if (uploadRequests.current.get(index) === controller) {
        updateSlot(index, { state: "error", file, message: errorMessage(error) });
      }
    } finally {
      if (uploadRequests.current.get(index) === controller) uploadRequests.current.delete(index);
    }
  }

  const ready = slots.every((slot) => slot?.state === "ready");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || submitRequest.current) return;
    const assetIds = slots.flatMap((slot) => slot?.state === "ready" ? [slot.asset.assetId] : []);
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
          slot?.state === "ready" && unavailable.has(slot.asset.assetId)
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
    <form className="create-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={submitting}>
        <legend>上传素材</legend>
        <p className="input-help">
          {template.requiredImageCount} 张图片 · JPEG / PNG · 单张 ≤ {template.maxFileSizeBytes / 1024 ** 2} MB
        </p>
        <div className="upload-list">
          {slots.map((slot, index) => (
            <UploadSlot key={index} index={index} template={template} slot={slot}
              choose={(file) => void upload(index, file)} remove={() => remove(index)} />
          ))}
        </div>
      </fieldset>
      <button className="primary-button" disabled={!ready || submitting} type="submit">
        {submitting ? "正在提交…" : "提交制作"} <span aria-hidden="true">↗</span>
      </button>
      {feedback && <p className={feedback.error ? "task-error" : "submit-feedback"}
        role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
    </form>
  );
}

function Cover({ template }: { template: Template }) {
  return (
    <>
      <p className="eyebrow">{template.category} / TEMPLATE</p>
      <h1>{template.title}<span>。</span></h1>
      <img className="workspace-cover" src={template.coverUrl} alt={template.title + "模板封面"} />
      <p className="template-description">{template.description}</p>
    </>
  );
}

function LoggedInWorkspace({ template }: { template: Template }) {
  const history = useHistory(template.id);
  return (
    <div className="workspace-grid">
      <section className="panel editor-panel">
        <Cover template={template} />
        <CreationForm template={template} accept={history.accept} />
      </section>
      <HistoryPanel history={history} />
    </div>
  );
}

export function TemplateWorkspace({ id }: { id: string }) {
  const { user, busy } = useSession();
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
    <div className="container workspace-page">
      <Link href="/templates" className="back-link">← 返回模板库</Link>
      {error ? (
        <div className="empty-box" role="alert">
          <h1>{error.missing ? "找不到这个模板" : "模板暂时无法加载"}</h1>
          <p>{error.message}</p>
          {!error.missing && <button className="secondary-button"
            onClick={() => { setError(null); setAttempt((key) => key + 1); }}>重新加载</button>}
        </div>
      ) : !template ? (
        <div className="empty-box" role="status">正在加载模板详情…</div>
      ) : !busy && user ? (
        <LoggedInWorkspace key={user.username} template={template} />
      ) : (
        <div className="workspace-grid">
          <section className="panel editor-panel"><Cover template={template} /></section>
          <AccountPrompt />
        </div>
      )}
    </div>
  );
}
