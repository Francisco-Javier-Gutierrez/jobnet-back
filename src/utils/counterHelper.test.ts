import { describe, it, expect, vi } from "vitest";
import { updateAtomicCounter } from "./counterHelper";

describe("counterHelper", () => {
  it("should return undefined if increment is 0", async () => {
    const mockClient = { send: vi.fn() };
    const res = await updateAtomicCounter(mockClient, "tbl", "PK#1", "likesCount", 0);
    expect(res).toBeUndefined();
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it("should increment counter atomically with ADD when increment > 0", async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Attributes: { likesCount: 5 },
      }),
    };
    const res = await updateAtomicCounter(mockClient, "tbl", "PK#1", "likesCount", 1);
    expect(res).toBe(5);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const cmd = mockClient.send.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toBe("ADD likesCount :inc");
    expect(cmd.input.ExpressionAttributeValues[":inc"]).toBe(1);
  });

  it("should decrement counter when increment < 0 and condition succeeds", async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Attributes: { bookmarksCount: 2 },
      }),
    };
    const res = await updateAtomicCounter(mockClient, "tbl", "PK#1", "bookmarksCount", -1);
    expect(res).toBe(2);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const cmd = mockClient.send.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toContain("attribute_exists(bookmarksCount)");
  });

  it("should clamp counter to 0 when decrement condition fails", async () => {
    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("ConditionalCheckFailedException"))
        .mockResolvedValueOnce({
          Attributes: { commentsCount: 0 },
        }),
    };
    const res = await updateAtomicCounter(mockClient, "tbl", "PK#1", "commentsCount", -1);
    expect(res).toBe(0);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
    const clampCmd = mockClient.send.mock.calls[1][0];
    expect(clampCmd.input.UpdateExpression).toBe("SET commentsCount = :zero");
    expect(clampCmd.input.ExpressionAttributeValues[":zero"]).toBe(0);
  });

  it("should gracefully catch general errors and return undefined", async () => {
    const mockClient = {
      send: vi.fn().mockRejectedValue(new Error("Network fatal error")),
    };
    const res = await updateAtomicCounter(mockClient, "tbl", "PK#1", "sharesCount", 1);
    expect(res).toBeUndefined();
  });
});
