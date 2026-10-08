import { CredentialsSignin } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ signIn }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

function form(fields: Record<string, string>, origin: string | null = "https://acme.example"): Request {
  return new Request("https://oneon.example/auth/impressorx", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: origin ? { origin } : {},
  });
}

// What Auth.js really does when authorize throws: signIn rejects with the error.
function rejection(code: string): CredentialsSignin {
  const error = new CredentialsSignin();
  error.code = code;
  return error;
}

describe("/auth/impressorx", () => {
  beforeEach(() => {
    signIn.mockReset();
  });

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

  it("signs in with the hand-off and the request Origin (no caller-chosen session id), then to the link step, which carries on to the dashboard", async () => {
    signIn.mockResolvedValue("https://oneon.example/");

    const res = await POST(form({ handoff: "the-jws", sessionId: "chosen-by-caller" }));

    expect(signIn).toHaveBeenCalledWith("impressorx", { handoff: "the-jws", origin: "https://acme.example", redirect: false, redirectTo: "/" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/link/complete");
  });

  it.each(["expired", "generic", "membership_suspended"])("sends a %s rejection to the error page with its reason", async (code) => {
    signIn.mockImplementation(async () => {
      throw rejection(code);
    });
    const res = await POST(form({ handoff: "x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/auth/error?reason=${code}`);
  });

  it("passes an absent Origin on as an empty value", async () => {
    signIn.mockResolvedValue("https://oneon.example/");
    await POST(form({ handoff: "x" }, null));
    expect(signIn.mock.calls[0]![1].origin).toBe("");
  });

  it("treats an unknown code, a thrown error or a missing hand-off as generic", async () => {
    signIn.mockImplementationOnce(async () => {
      throw rejection("credentials");
    });
    expect((await POST(form({ handoff: "x" }))).headers.get("location")).toBe("/auth/error?reason=generic");

    signIn.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(form({ handoff: "x" }))).headers.get("location")).toBe("/auth/error?reason=generic");

    signIn.mockClear();
    expect((await POST(form({}))).headers.get("location")).toBe("/auth/error?reason=generic");
    expect(signIn).not.toHaveBeenCalled();
  });
});
