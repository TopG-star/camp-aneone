import { describe, expect, it, vi } from "vitest";
import { clearLinkIntentCookie, linkCookie, readLinkIntent, serializeLinkIntent } from "./link-cookie";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);

describe("link intent cookie", () => {
  it("is HttpOnly, SameSite=Lax, limited to the link pages, lives 5 minutes and is Secure over https and in production", () => {
    for (const env of [{ AUTH_URL: "https://oneon.example" }, { NEXTAUTH_URL: "https://oneon.example" }, { NODE_ENV: "production" }]) {
      const cookie = linkCookie(env);
      expect(cookie.name).toBe("__Secure-oneon-link-intent");
      expect(cookie.options).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/auth/link", maxAge: 300 });
    }
  });

  it("is not Secure only for plain-http development", () => {
    const cookie = linkCookie({ NODE_ENV: "development", AUTH_URL: "http://localhost:3000" });
    expect(cookie.name).toBe("oneon-link-intent");
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, maxAge: 300 });
  });

  it("round-trips the id and secret and ignores every other cookie", () => {
    const value = serializeLinkIntent({ linkIntentId: ID, secret: SECRET });
    expect(readLinkIntent(`theme=dark; oneon-link-intent=${value}; x=1`, "oneon-link-intent")).toEqual({ linkIntentId: ID, secret: SECRET });
    expect(readLinkIntent(`__Secure-oneon-link-intent=${value}`, "oneon-link-intent")).toBeNull();
    expect(readLinkIntent("", "oneon-link-intent")).toBeNull();
  });

  it("rejects a malformed value", () => {
    for (const bad of ["", "nodot", `${ID}.`, `.${SECRET}`, `${ID}.${SECRET}.extra`, `not an id.${SECRET}`, `${ID}.short`]) {
      expect(readLinkIntent(`oneon-link-intent=${bad}`, "oneon-link-intent")).toBeNull();
    }
  });

  it("is cleared by expiring it on the path it was set on", () => {
    const store = { set: vi.fn() };

    clearLinkIntentCookie(store, { NODE_ENV: "development" });

    expect(store.set).toHaveBeenCalledWith("oneon-link-intent", "", expect.objectContaining({ path: "/auth/link", maxAge: 0, httpOnly: true, sameSite: "lax" }));
  });
});
