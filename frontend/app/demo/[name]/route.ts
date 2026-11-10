import { fromJava } from "../../../lib/upstream";

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9-]+\.jpg$/.test(name)) return new Response(null, { status: 404 });
  return fromJava(request, "/demo/" + name);
}
