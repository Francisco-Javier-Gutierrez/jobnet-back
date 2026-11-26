import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkUserAiCooldown,
  setUserAiCooldown,
  deleteUserAiCooldown,
  checkJobAiCooldown,
  setJobAiCooldown,
  deleteJobAiCooldown,
  AI_COOLDOWN_SECONDS,
} from "./aiCooldownHelper";

describe("aiCooldownHelper", () => {
  const mockDocClient = {
    send: vi.fn(),
  };
  const tableName = "TestTable";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return isBlocked: false if userId is empty", async () => {
    const res = await checkUserAiCooldown(mockDocClient as any, tableName, "");
    expect(res.isBlocked).toBe(false);
    expect(mockDocClient.send).not.toHaveBeenCalled();
  });

  it("should return isBlocked: false if no cooldown item exists in DynamoDB", async () => {
    mockDocClient.send.mockResolvedValueOnce({ Item: null });

    const res = await checkUserAiCooldown(mockDocClient as any, tableName, "user-123");
    expect(res.isBlocked).toBe(false);
    expect(res.remainingSeconds).toBe(0);
  });

  it("should return isBlocked: true if cooldown item is present and unexpired", async () => {
    const futureTtl = Math.floor(Date.now() / 1000) + 7200; // 2 horas en el futuro
    mockDocClient.send.mockResolvedValueOnce({
      Item: {
        PK: "USER#user-123",
        SK: "AI_COOLDOWN",
        userId: "user-123",
        ttl: futureTtl,
        expiresAt: new Date(futureTtl * 1000).toISOString(),
      },
    });

    const res = await checkUserAiCooldown(mockDocClient as any, tableName, "user-123");
    expect(res.isBlocked).toBe(true);
    expect(res.remainingSeconds).toBeGreaterThan(7000);
    expect(res.remainingMs).toBeGreaterThan(7000000);
    expect(res.expiresAt).toBeDefined();
  });

  it("should return isBlocked: false if cooldown item exists but TTL has already elapsed", async () => {
    const pastTtl = Math.floor(Date.now() / 1000) - 300; // expiró hace 5 minutos
    mockDocClient.send.mockResolvedValueOnce({
      Item: {
        PK: "USER#user-123",
        SK: "AI_COOLDOWN",
        userId: "user-123",
        ttl: pastTtl,
      },
    });

    const res = await checkUserAiCooldown(mockDocClient as any, tableName, "user-123");
    expect(res.isBlocked).toBe(false);
  });

  it("should create a cooldown record in DynamoDB with exact 24h TTL", async () => {
    mockDocClient.send.mockResolvedValueOnce({});

    const beforeSeconds = Math.floor(Date.now() / 1000);
    const item = await setUserAiCooldown(
      mockDocClient as any,
      tableName,
      "user-123",
      "ATS_CANDIDATE_RANKING",
      "job-456",
    );

    expect(item.PK).toBe("USER#user-123");
    expect(item.SK).toBe("AI_COOLDOWN");
    expect(item.userId).toBe("user-123");
    expect(item.jobId).toBe("job-456");
    expect(item.ttl).toBeGreaterThanOrEqual(beforeSeconds + AI_COOLDOWN_SECONDS);
    expect(item.expiresAt).toBeDefined();

    expect(mockDocClient.send).toHaveBeenCalledTimes(1);
  });

  it("should delete cooldown record when requested", async () => {
    mockDocClient.send.mockResolvedValueOnce({});

    await deleteUserAiCooldown(mockDocClient as any, tableName, "user-123");
    expect(mockDocClient.send).toHaveBeenCalledTimes(1);
  });

  describe("checkJobAiCooldown & setJobAiCooldown", () => {
    it("should return isBlocked: false if jobId is empty", async () => {
      const res = await checkJobAiCooldown(mockDocClient as any, tableName, "");
      expect(res.isBlocked).toBe(false);
      expect(mockDocClient.send).not.toHaveBeenCalled();
    });

    it("should return isBlocked: false if no cooldown item exists for job", async () => {
      mockDocClient.send.mockResolvedValueOnce({ Item: null });

      const res = await checkJobAiCooldown(mockDocClient as any, tableName, "job-101");
      expect(res.isBlocked).toBe(false);
      expect(res.remainingSeconds).toBe(0);
    });

    it("should return isBlocked: true if job cooldown item is unexpired", async () => {
      const futureTtl = Math.floor(Date.now() / 1000) + 3600;
      mockDocClient.send.mockResolvedValueOnce({
        Item: {
          PK: "JOB#job-101",
          SK: "AI_COOLDOWN",
          jobId: "job-101",
          ttl: futureTtl,
          expiresAt: new Date(futureTtl * 1000).toISOString(),
        },
      });

      const res = await checkJobAiCooldown(mockDocClient as any, tableName, "job-101");
      expect(res.isBlocked).toBe(true);
      expect(res.remainingSeconds).toBeGreaterThan(0);
    });

    it("should create job cooldown record in DynamoDB with exact 24h TTL", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const beforeSeconds = Math.floor(Date.now() / 1000);
      const item = await setJobAiCooldown(
        mockDocClient as any,
        tableName,
        "job-101",
        "user-1",
        "emp-1",
      );

      expect(item.PK).toBe("JOB#job-101");
      expect(item.SK).toBe("AI_COOLDOWN");
      expect(item.jobId).toBe("job-101");
      expect(item.userId).toBe("user-1");
      expect(item.empresaUuid).toBe("emp-1");
      expect(item.ttl).toBeGreaterThanOrEqual(beforeSeconds + AI_COOLDOWN_SECONDS);
    });

    it("should delete job cooldown record when requested", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await deleteJobAiCooldown(mockDocClient as any, tableName, "job-101");
      expect(mockDocClient.send).toHaveBeenCalledTimes(1);
    });
  });
});
