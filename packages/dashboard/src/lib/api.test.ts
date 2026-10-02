import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api";

function stubBrowser(status: number, body: unknown) {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname: "/actions", search: "", assign } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ),
  );
  return assign;
}

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch auth redirect", () => {
  it("redirects to sign-in on 403 by default", async () => {
    const assign = stubBrowser(403, { error: "nope" });
    await expect(apiFetch("/x")).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledOnce();
  });

  it("does not redirect on 403 with redirectOnAuth: false and keeps the message", async () => {
    const assign = stubBrowser(403, { error: "This action cannot be automatically reversed." });
    await expect(apiFetch("/x", undefined, { redirectOnAuth: false })).rejects.toMatchObject({
      status: 403,
      message: "This action cannot be automatically reversed.",
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("still redirects on 401 with redirectOnAuth: false", async () => {
    const assign = stubBrowser(401, { error: "Unauthorized" });
    await expect(apiFetch("/x", undefined, { redirectOnAuth: false })).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledOnce();
  });
});

describe("apiFetch error message", () => {
  it("appends issues to the error", async () => {
    stubBrowser(422, { error: "Retry refused", issues: ["a is bad", "b is bad"] });
    await expect(apiFetch("/x")).rejects.toMatchObject({ message: "Retry refused: a is bad; b is bad" });
  });
});
