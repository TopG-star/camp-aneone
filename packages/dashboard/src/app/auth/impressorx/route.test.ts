import { beforeEach, describe, expect, it, vi } from "vitest";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ signIn }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(fields: Record<string, string>): Request {
  return new Request("https://oneon.example/auth/impressorx", { method: "POST", body: new URLSearchParams(fields) });
}

describe("/auth/impressorx", () => {
  beforeEach(() => signIn.mockReset());

  it.each([
    ["GET", GET],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("rejects %s with 405 and signs nobody in", async (_method, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("signs in with the hand-off and a fresh session id, then goes to the dashboard", async () => {
    signIn.mockResolvedValue("https://oneon.example/");

    const res = await POST(form({ handoff: "the-jws" }));

    expect(signIn).toHaveBeenCalledWith("impressorx", { handoff: "the-jws", sessionId: expect.stringMatching(UUID), redirect: false, redirectTo: "/" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("uses a different session id for every hand-off", async () => {
    signIn.mockResolvedValue("https://oneon.example/");
    await POST(form({ handoff: "a" }));
    await POST(form({ handoff: "b" }));
    expect(signIn.mock.calls[0]![1].sessionId).not.toBe(signIn.mock.calls[1]![1].sessionId);
  });

  it.each(["expired", "generic", "membership_suspended"])("sends a %s rejection to the error page with its reason", async (code) => {
    signIn.mockResolvedValue(`https://oneon.example/auth/signin?error=CredentialsSignin&code=${code}`);
    const res = await POST(form({ handoff: "x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/auth/error?reason=${code}`);
  });

  it("treats an unknown code, a thrown error or a missing hand-off as generic", async () => {
    signIn.mockResolvedValueOnce("https://oneon.example/auth/signin?error=CredentialsSignin&code=credentials");
    expect((await POST(form({ handoff: "x" }))).headers.get("location")).toBe("/auth/error?reason=generic");

    signIn.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(form({ handoff: "x" }))).headers.get("location")).toBe("/auth/error?reason=generic");

    signIn.mockClear();
    expect((await POST(form({}))).headers.get("location")).toBe("/auth/error?reason=generic");
    expect(signIn).not.toHaveBeenCalled();
  });
});
