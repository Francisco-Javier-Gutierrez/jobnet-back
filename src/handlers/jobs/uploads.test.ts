import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockS3Send, mockSESSend, mockGetSignedUrl } = vi.hoisted(() => {
  return {
    mockS3Send: vi.fn(),
    mockSESSend: vi.fn(),
    mockGetSignedUrl: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({}),
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = mockS3Send;
  },
  PutObjectCommand: class {
    constructor(public params: any) {}
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = mockSESSend;
  },
  SendEmailCommand: class {
    constructor(public params: any) {}
  },
}));

import { getUploadPresignedUrl, sendNotificationEmail } from "./uploads";

describe("jobs uploads & emails handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockReset();
    mockSESSend.mockReset();
    mockGetSignedUrl.mockReset();
    mockGetSignedUrl.mockResolvedValue(
      "https://s3.amazonaws.com/presigned-url",
    );
    mockSESSend.mockResolvedValue({});
  });

  describe("getUploadPresignedUrl", () => {
    it("should return 400 if filename contains a dangerous executable extension", async () => {
      const event = {
        queryStringParameters: { filename: "virus.exe", size: "1024" },
      } as any;

      const res = await getUploadPresignedUrl(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain(
        "Extensión de archivo peligrosa",
      );
    });

    it("should return 400 if filename has double extension suspicious pattern (e.g. cv.pdf.xyz)", async () => {
      const event = {
        queryStringParameters: { filename: "cv.pdf.xyz", size: "1024" },
      } as any;

      const res = await getUploadPresignedUrl(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain(
        "Validación de doble extensión fallida",
      );
    });

    it("should return 400 if size is missing or invalid", async () => {
      const event1 = { queryStringParameters: { filename: "cv.pdf" } } as any;
      const res1 = await getUploadPresignedUrl(event1, {} as any, () => {});
      expect(res1.statusCode).toBe(400);

      const event2 = {
        queryStringParameters: { filename: "cv.pdf", size: "abc" },
      } as any;
      const res2 = await getUploadPresignedUrl(event2, {} as any, () => {});
      expect(res2.statusCode).toBe(400);
    });

    it("should return 400 if size exceeds 5MB limit", async () => {
      const event = {
        queryStringParameters: {
          filename: "video.mp4",
          size: (6 * 1024 * 1024).toString(),
        },
      } as any;

      const res = await getUploadPresignedUrl(event, {} as any, () => {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("supera el límite de 5MB");
    });

    it("should return 200 with presigned URL and key on success", async () => {
      const event = {
        queryStringParameters: {
          filename: "mi curriculum.pdf",
          size: "2048",
          folder: "resumes",
          userId: "user-123",
          contentType: "application/pdf",
        },
      } as any;

      const res = await getUploadPresignedUrl(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.url).toBe("https://s3.amazonaws.com/presigned-url");
      expect(data.key).toContain("uploads/resumes/user-123/");
      expect(data.key).toContain("mi_curriculum.pdf");
      expect(data.publicUrl).toContain("https://");
    });

    it("should return 500 on S3 signing error", async () => {
      mockGetSignedUrl.mockRejectedValueOnce(new Error("S3 signing error"));

      const event = {
        queryStringParameters: { filename: "doc.pdf", size: "100" },
      } as any;

      const res = await getUploadPresignedUrl(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe("S3 signing error");
    });
  });

  describe("sendNotificationEmail", () => {
    it("should send SES email successfully", async () => {
      const event = {
        body: JSON.stringify({
          to: "user@example.com",
          subject: "Nueva Notificación",
          message: "Hola mundo",
        }),
      } as any;

      const res = await sendNotificationEmail(event, {} as any, () => {});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(mockSESSend).toHaveBeenCalledTimes(1);
    });

    it("should return 500 on SES service failure", async () => {
      mockSESSend.mockRejectedValueOnce(new Error("SES service error"));

      const event = {
        body: JSON.stringify({
          to: "user@example.com",
          subject: "Test",
          message: "Test",
        }),
      } as any;

      const res = await sendNotificationEmail(event, {} as any, () => {});
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe("SES service error");
    });
  });
});
