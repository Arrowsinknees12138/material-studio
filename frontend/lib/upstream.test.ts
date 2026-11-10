import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromJava } from "./upstream";

describe("Java proxy", () => {
  beforeEach(() => vi.stubEnv("JAVA_API_BASE_URL", "http://java.test:8080"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the history query and current session identity to Java", async () => {
    const fetchJava = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchJava);
    const request = new Request("http://web.test/api/tasks/history?templateId=moon&active=true&limit=50", {
      headers: { Cookie: "STUDIO_SESSION=abc", "X-Studio-Account": "lin", Authorization: "unexpected" },
    });

    const response = await fromJava(request, "/api/tasks/history");

    const [url, options] = fetchJava.mock.calls[0];
    expect(String(url)).toBe("http://java.test:8080/api/tasks/history?templateId=moon&active=true&limit=50");
    expect(options).toMatchObject({ method: "GET", cache: "no-store", signal: request.signal });
    expect(new Headers(options?.headers).get("cookie")).toBe("STUDIO_SESSION=abc");
    expect(new Headers(options?.headers).get("x-studio-account")).toBe("lin");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("streams multipart data with its original content type and operation header", async () => {
    const data = new FormData();
    data.set("templateId", "moon");
    data.set("file", new File([Uint8Array.of(0xff, 0xd8, 0xff)], "upload.jpg", { type: "image/jpeg" }));
    const request = new Request("http://web.test/api/assets", {
      method: "POST", headers: { "X-Studio-Request": "1" }, body: data,
    });
    const fetchJava = vi.fn<typeof fetch>(async (url, options) => {
      const forwarded = new Request(url, options);
      expect(forwarded.headers.get("x-studio-request")).toBe("1");
      expect(forwarded.headers.get("content-type")).toBe(request.headers.get("content-type"));
      expect(options).toMatchObject({ duplex: "half" });
      const form = await forwarded.formData();
      expect(form.get("templateId")).toBe("moon");
      expect(form.get("file")).toMatchObject({ name: "upload.jpg", size: 3, type: "image/jpeg" });
      return Response.json({ assetId: "asset-1" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchJava);

    const response = await fromJava(request, "/api/assets");

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ assetId: "asset-1" });
  });

  it("preserves multiple Set-Cookie headers and a bodyless logout", async () => {
    const cookies = ["STUDIO_SESSION=; Max-Age=0; Path=/", "other=1; Path=/"];
    const headers = new Headers();
    cookies.forEach((cookie) => headers.append("Set-Cookie", cookie));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204, headers })));

    const response = await fromJava(new Request("http://web.test/api/session/logout", { method: "POST" }),
      "/api/session/logout");

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(cookies);
  });

  it("preserves Java error status and payload while separating upstream transport failures", async () => {
    const error = { message: "素材已失效。", unavailableAssetIds: ["asset-1"] };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(error, { status: 400 }))
      .mockRejectedValueOnce(new TypeError("connection refused")));
    const request = new Request("http://web.test/api/tasks", { method: "POST" });

    const rejected = await fromJava(request, "/api/tasks");
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual(error);

    const disconnected = await fromJava(request, "/api/tasks");
    expect(disconnected.status).toBe(502);
    await expect(disconnected.json()).resolves.toEqual({ message: "暂时无法连接制作服务，请稍后重试。" });
  });
});
