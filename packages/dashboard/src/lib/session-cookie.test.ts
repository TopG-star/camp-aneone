import { describe, expect, it } from "vitest";
import { sessionCookie } from "./session-cookie";

describe("session cookie", () => {
  it("is HttpOnly, Secure and SameSite=Lax over https and in production", () => {
    for (const env of [{ AUTH_URL: "https://oneon.example" }, { NEXTAUTH_URL: "https://oneon.example" }, { NODE_ENV: "production" }]) {
      const cookie = sessionCookie(env);
      expect(cookie.useSecureCookies).toBe(true);
      expect(cookie.name).toBe("__Secure-authjs.session-token");
      expect(cookie.options).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    }
  });

  it("is only non-Secure for plain-http development", () => {
    const cookie = sessionCookie({ NODE_ENV: "development", AUTH_URL: "http://localhost:3000" });
    expect(cookie.useSecureCookies).toBe(false);
    expect(cookie.name).toBe("authjs.session-token");
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false });
  });
});
