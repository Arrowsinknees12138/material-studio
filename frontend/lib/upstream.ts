export async function fromJava(request: Request, path: string): Promise<Response> {
  const base = process.env.JAVA_API_BASE_URL ?? "http://127.0.0.1:8080";
  const url = new URL(path, base);
  url.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "x-studio-request", "x-studio-account"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const options: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      cache: "no-store",
      signal: request.signal,
    };
    if (request.body) {
      options.body = request.body;
      options.duplex = "half";
    }
    const upstream = await fetch(url, options);
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["content-type", "x-content-type-options"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    for (const cookie of upstream.headers.getSetCookie()) {
      responseHeaders.append("Set-Cookie", cookie);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ message: "暂时无法连接制作服务，请稍后重试。" }, { status: 502 });
  }
}
