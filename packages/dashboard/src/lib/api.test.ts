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

  it("formats an errors array of { field, message } when there is no error string", async () => {
    stubBrowser(422, { errors: [{ field: "approval.mode", message: "looser than allowed" }, { field: "(body)", message: "Unrecognized key" }] });
    await expect(apiFetch("/x")).rejects.toMatchObject({
      status: 422,
      message: "approval.mode: looser than allowed; (body): Unrecognized key",
    });
  });

  it("prefers the error string over an errors array", async () => {
    stubBrowser(422, { error: "Nope", errors: [{ field: "a", message: "b" }] });
    await expect(apiFetch("/x")).rejects.toMatchObject({ message: "Nope" });
  });
});

describe("apiFetch context refusals", () => {
  it.each([
    ["launch_required", "Open Oneon from ImpressoRx again to continue."],
    ["membership_suspended", "This pharmacy has switched Oneon off, or your account is inactive."],
  ])("shows the %s message and does not send the person to sign-in", async (code, message) => {
    const assign = stubBrowser(403, { error: code, message });
    await expect(apiFetch("/x")).rejects.toMatchObject({ status: 403, message });
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the message of a context_unavailable validate refusal too, but still redirects other 403s", async () => {
    stubBrowser(403, { error: "context_unavailable", message: "That context isn't available to you." });
    await expect(apiFetch("/x", undefined, { redirectOnAuth: false })).rejects.toMatchObject({ message: "That context isn't available to you." });

    const assign = stubBrowser(403, { error: "context_unavailable" });
    await expect(apiFetch("/x")).rejects.toMatchObject({ message: "context_unavailable" });
    expect(assign).toHaveBeenCalledOnce();
  });
});

describe("apiFetch personal-only routes", () => {
  it("tells a Google session in a pharmacy to switch to Personal and does not send them to sign-in", async () => {
    const assign = stubBrowser(403, { error: "personal_context_required" });
    await expect(apiFetch("/x")).rejects.toMatchObject({ status: 403, message: "Switch to Personal to use this." });
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a hand-off session the server's own message: Personal is not on offer there", async () => {
    const message = "Personal isn't available when you open Oneon from a pharmacy. Sign in with Google to use it.";
    const assign = stubBrowser(403, { error: "personal_context_required", message });
    await expect(apiFetch("/x")).rejects.toMatchObject({ status: 403, message });
    expect(assign).not.toHaveBeenCalled();
  });
});
