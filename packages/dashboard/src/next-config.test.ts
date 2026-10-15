import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const config = createRequire(import.meta.url)("../next.config.js") as {
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
};

describe("dashboard security headers", () => {
  it("every response carries Content-Security-Policy frame-ancestors 'none'", async () => {
    const rules = await config.headers();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "Content-Security-Policy", value: "frame-ancestors 'none'" });
  });
});
