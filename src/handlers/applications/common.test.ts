import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("applications common", () => {
  const originalEnv = process.env.IS_OFFLINE;

  afterEach(() => {
    process.env.IS_OFFLINE = originalEnv;
  });

  it("should initialize with default clients when IS_OFFLINE is false", async () => {
    process.env.IS_OFFLINE = "false";
    vi.resetModules();
    const common = await import("./common");
    expect(common.isOffline).toBe(false);
    expect(common.tableName).toBeDefined();
    expect(common.VALID_STATUSES).toHaveLength(5);
  });

  it("should initialize with local endpoint clients when IS_OFFLINE is true", async () => {
    process.env.IS_OFFLINE = "true";
    vi.resetModules();
    const common = await import("./common");
    expect(common.isOffline).toBe(true);
  });
});
