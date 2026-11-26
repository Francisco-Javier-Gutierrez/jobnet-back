import { describe, it, expect, vi, beforeEach } from "vitest";
import { moderateS3Media } from "./s3ModerationHelper";
import * as aiModeration from "./aiModeration";

const mockS3Send = vi.fn();

vi.mock("../handlers/jobs/common", () => ({
  s3Client: {
    send: (cmd: any) => mockS3Send(cmd),
  },
  bucketName: "test-bucket",
}));

describe("S3 Media Moderation Helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return safe if urlOrKey is empty", async () => {
    const res = await moderateS3Media("", "IMAGE");
    expect(res.safe).toBe(true);
  });

  it("should return safe if key pattern cannot be resolved", async () => {
    const res = await moderateS3Media("http://invalid-url.com/other", "IMAGE");
    expect(res.safe).toBe(true);
  });

  it("should download image from S3 and invoke moderateImageWithAi", async () => {
    const fakeBytes = new Uint8Array([1, 2, 3]);
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => fakeBytes,
      },
      ContentType: "image/png",
    });

    const spyImage = vi.spyOn(aiModeration, "moderateImageWithAi").mockResolvedValueOnce({
      safe: false,
      confidence: 0.99,
      flaggedCategories: ["NSFW"],
      reason: "Imagen inapropiada",
    });

    const res = await moderateS3Media(
      "https://test-bucket.s3.amazonaws.com/uploads/posts/user-1/foto.png",
      "IMAGE",
    );

    expect(spyImage).toHaveBeenCalled();
    expect(res.safe).toBe(false);
    expect(res.flaggedCategories).toContain("NSFW");
  });

  it("should download PDF from S3 and invoke moderateDocumentWithAi", async () => {
    const fakeBytes = new Uint8Array([37, 80, 68, 70]);
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => fakeBytes,
      },
      ContentType: "application/pdf",
    });

    const spyDoc = vi.spyOn(aiModeration, "moderateDocumentWithAi").mockResolvedValueOnce({
      safe: true,
      confidence: 0.95,
      flaggedCategories: [],
      reason: null,
    });

    const res = await moderateS3Media("uploads/cvs/user-1/cv.pdf", "PDF");
    expect(spyDoc).toHaveBeenCalled();
    expect(res.safe).toBe(true);
  });

  it("should handle S3 read failures gracefully without throwing", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("S3 Access Denied"));
    const res = await moderateS3Media("uploads/posts/user-1/foto.png", "IMAGE");
    expect(res.safe).toBe(true);
  });
});
