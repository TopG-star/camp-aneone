import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TTLCache } from "../ttl-cache.js";

describe("TTLCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic get / set ────────────────────────────────────

  it("returns undefined for a cache miss", () => {
    const cache = new TTLCache<string>();
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("stores and retrieves a value within TTL", () => {
    const cache = new TTLCache<number>();
    cache.set("counter", 42, 5000);
    expect(cache.get("counter")).toBe(42);
  });

  it("returns undefined after TTL expires", () => {
    const cache = new TTLCache<string>();
    cache.set("key", "value", 3000);

    vi.advanceTimersByTime(3001);

    expect(cache.get("key")).toBeUndefined();
  });

  it("returns value just before TTL expires", () => {
    const cache = new TTLCache<string>();
    cache.set("key", "value", 3000);

    vi.advanceTimersByTime(2999);

    expect(cache.get("key")).toBe("value");
  });

  // ── has ────────────────────────────────────────────────

  it("has() returns true for a live entry", () => {
    const cache = new TTLCache<string>();
    cache.set("key", "value", 5000);
    expect(cache.has("key")).toBe(true);
  });

  it("has() returns false for an expired entry", () => {
    const cache = new TTLCache<string>();
    cache.set("key", "value", 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.has("key")).toBe(false);
  });

  it("has() returns false for a missing key", () => {
    const cache = new TTLCache<string>();
    expect(cache.has("nope")).toBe(false);
  });

  // ── invalidate ─────────────────────────────────────────

  it("invalidate() removes a specific key", () => {
    const cache = new TTLCache<string>();
    cache.set("a", "1", 5000);
    cache.set("b", "2", 5000);

    cache.invalidate("a");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  // ── invalidateByPrefix ─────────────────────────────────

  it("invalidateByPrefix() removes all keys matching prefix", () => {
    const cache = new TTLCache<string>();
    cache.set("cal:primary:list:abc", "events1", 5000);
    cache.set("cal:primary:search:def", "events2", 5000);
    cache.set("cal:work:list:ghi", "events3", 5000);
    cache.set("other:key", "unrelated", 5000);

    cache.invalidateByPrefix("cal:primary:");

    expect(cache.get("cal:primary:list:abc")).toBeUndefined();
    expect(cache.get("cal:primary:search:def")).toBeUndefined();
    expect(cache.get("cal:work:list:ghi")).toBe("events3");
    expect(cache.get("other:key")).toBe("unrelated");
  });

  // ── clear ──────────────────────────────────────────────

  it("clear() removes all entries", () => {
    const cache = new TTLCache<string>();
    cache.set("a", "1", 5000);
    cache.set("b", "2", 5000);

    cache.clear();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  // ── getOrSet ───────────────────────────────────────────

  it("getOrSet() returns cached value without calling factory", async () => {
    const cache = new TTLCache<string>();
    cache.set("key", "cached", 5000);

    const factory = vi.fn().mockResolvedValue("fresh");
    const result = await cache.getOrSet("key", factory, 5000);

    expect(result).toBe("cached");
    expect(factory).not.toHaveBeenCalled();
  });

  it("getOrSet() calls factory on cache miss and stores result", async () => {
    const cache = new TTLCache<string>();

    const factory = vi.fn().mockResolvedValue("fresh-value");
    const result = await cache.getOrSet("key", factory, 5000);

    expect(result).toBe("fresh-value");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.get("key")).toBe("fresh-value");
  });

  it("getOrSet() calls factory after TTL expiry", async () => {
    const cache = new TTLCache<string>();
    cache.set("key", "stale", 1000);

    vi.advanceTimersByTime(1001);

    const factory = vi.fn().mockResolvedValue("refreshed");
    const result = await cache.getOrSet("key", factory, 1000);

    expect(result).toBe("refreshed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  // ── overwrite ──────────────────────────────────────────

  it("set() overwrites existing value and resets TTL", () => {
    const cache = new TTLCache<string>();
    cache.set("key", "old", 1000);

    vi.advanceTimersByTime(500);
    cache.set("key", "new", 2000);

    vi.advanceTimersByTime(1500);
    // Old TTL (1000) would have expired, but new TTL (2000 from set at t=500) keeps it alive
    expect(cache.get("key")).toBe("new");
  });
});
