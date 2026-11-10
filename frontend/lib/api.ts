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

export const stageLabels: Record<TaskStage, string> = {
  CHECK_INPUTS: "素材检查",
  GENERATE: "模拟生成",
  FINALIZE: "结果整理",
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== "GET") headers.set("X-Studio-Request", "1");
  let response: Response;
  try {
    response = await fetch("/api" + path, { ...options, headers, cache: "no-store" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, "网络连接暂时不可用，请重试。");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(response.status, payload?.message ?? "请求失败，请重试。");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
