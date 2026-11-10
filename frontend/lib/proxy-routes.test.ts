import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as apiGet, POST as apiPost } from "../app/api/[...path]/route";
import { GET as demoGet } from "../app/demo/[name]/route";
import { fromJava } from "./upstream";

vi.mock("./upstream", () => ({ fromJava: vi.fn() }));
const forward = vi.mocked(fromJava);

beforeEach(() => forward.mockReset());

describe("Next.js proxy route boundaries", () => {
  it.each([
    { path: ["tasks", "updates"] }, { path: ["session", "logout"] },
    { path: ["assets", "asset-1", "content"] }, { path: ["templates"] },
  ])(
    "forwards the allowed API segments $path",
    async ({ path }) => {
      const request = new Request("http://web.test/api/" + path.join("/"));
      forward.mockResolvedValue(new Response(null, { status: 200 }));

      expect((await apiGet(request, { params: Promise.resolve({ path }) })).status).toBe(200);
      expect(forward).toHaveBeenCalledWith(request, "/api/" + path.join("/"));
    },
  );

  it.each([
    { path: [] }, { path: ["actuator", "health"] }, { path: ["tasks", ".."] },
    { path: ["assets", "nested/path"] }, { path: ["templates", "id?injected"] },
  ])("rejects disallowed API segments $path without forwarding", async ({ path }) => {
    const request = new Request("http://web.test/api/tasks", { method: "POST" });

    expect((await apiPost(request, { params: Promise.resolve({ path }) })).status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards a JPEG demo filename", async () => {
    const request = new Request("http://web.test/demo/moon-result.jpg");
    forward.mockResolvedValue(new Response(null, { status: 200 }));

    expect((await demoGet(request, { params: Promise.resolve({ name: "moon-result.jpg" }) })).status).toBe(200);
    expect(forward).toHaveBeenCalledWith(request, "/demo/moon-result.jpg");
  });

  it.each(["moon.png", "../moon.jpg", "nested/moon.jpg", "moon.jpg?x=1"])(
    "rejects disallowed demo filename %s",
    async (name) => {
      const request = new Request("http://web.test/demo/moon.jpg");

      expect((await demoGet(request, { params: Promise.resolve({ name }) })).status).toBe(404);
      expect(forward).not.toHaveBeenCalled();
    },
  );
});
