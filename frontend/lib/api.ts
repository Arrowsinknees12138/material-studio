export interface User {
  username: string;
  displayName: string;
}

export interface Template {
  id: string;
  title: string;
  category: string;
  description: string;
  coverUrl: string;
  requiredImageCount: number;
  acceptedMimeTypes: string[];
  maxFileSizeBytes: number;
  maxImagePixels: number;
}

export interface Catalog {
  categories: string[];
  templates: Template[];
}

export interface Asset {
  assetId: string;
  previewUrl: string;
  contentType: string;
  byteSize: number;
}

export type TaskStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type TaskStage = "CHECK_INPUTS" | "GENERATE" | "FINALIZE";

export interface Task {
  id: string;
  templateId: string;
  templateTitle: string;
  status: TaskStatus;
  stage: TaskStage | null;
  createdAt: string;
  completedAt: string | null;
  resultUrl: string | null;
  errorMessage: string | null;
}

export interface TaskPage {
  items: Task[];
  nextCursor: string | null;
}

export const sessionCheckEvent = "studio:check-session";

export const stageLabels: Record<TaskStage, string> = {
  CHECK_INPUTS: "素材检查",
  GENERATE: "模拟生成",
  FINALIZE: "结果整理",
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly unavailableAssetIds: string[] = []) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? "GET";
  if (method !== "GET") headers.set("X-Studio-Request", "1");

  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), method === "GET" ? 8000 : 30000);

  try {
    const response = await fetch("/api" + path, { ...options, headers, signal, cache: "no-store" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      if (response.status === 401 && !path.startsWith("/session") && typeof window !== "undefined") {
        window.dispatchEvent(new Event(sessionCheckEvent));
      }
      const ids = payload?.unavailableAssetIds;
      throw new ApiError(response.status, payload?.message ?? "请求失败，请重试。",
        Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.signal.aborted) throw new ApiError(0, "请求超时，请重试。");
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "网络连接暂时不可用，请重试。");
  } finally {
    clearTimeout(timer);
  }
}

export function jsonBody(data: object, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作暂时失败，请重试。";
}
