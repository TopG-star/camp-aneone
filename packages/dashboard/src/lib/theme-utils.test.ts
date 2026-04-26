import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  normalizeThemeMode,
  resolveThemeMode,
  nextQuickToggleMode,
} from "./theme-utils";

describe("theme-utils", () => {
  describe("normalizeThemeMode", () => {
    it("returns system when storage is empty", () => {
      expect(normalizeThemeMode(null)).toBe("system");
      expect(normalizeThemeMode(undefined)).toBe("system");
      expect(normalizeThemeMode("")).toBe("system");
    });

    it("accepts valid stored values", () => {
      expect(normalizeThemeMode("light")).toBe("light");
      expect(normalizeThemeMode("dark")).toBe("dark");
      expect(normalizeThemeMode("system")).toBe("system");
    });

    it("falls back to system for unknown values", () => {
      expect(normalizeThemeMode("sepia")).toBe("system");
      expect(normalizeThemeMode("true")).toBe("system");
    });
  });

  describe("resolveThemeMode", () => {
    it("resolves system based on OS preference", () => {
      expect(resolveThemeMode("system", true)).toBe("dark");
      expect(resolveThemeMode("system", false)).toBe("light");
    });

    it("uses explicit mode without OS preference", () => {
      expect(resolveThemeMode("dark", false)).toBe("dark");
      expect(resolveThemeMode("light", true)).toBe("light");
    });
  });

  describe("nextQuickToggleMode", () => {
    it("returns explicit opposite mode from resolved state", () => {
      expect(nextQuickToggleMode("dark")).toBe("light");
      expect(nextQuickToggleMode("light")).toBe("dark");
    });
  });

  it("exports a stable storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("oneon-theme");
  });
});
