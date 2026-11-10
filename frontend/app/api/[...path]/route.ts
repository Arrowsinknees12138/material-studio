import { fromJava } from "../../../lib/upstream";

const resources = new Set(["session", "templates", "assets", "tasks"]);

async function forward(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!resources.has(path[0]) || !path.every((part) => /^[a-zA-Z0-9-]+$/.test(part))) {
    return Response.json({ message: "未找到接口。" }, { status: 404 });
  }
  return fromJava(request, "/api/" + path.join("/"));
}

export { forward as GET, forward as POST };
