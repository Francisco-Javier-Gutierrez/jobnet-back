import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => {
  return {
    mockDynamoSend: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: mockDynamoSend,
    }),
  },
  QueryCommand: class {
    constructor(public params: any) {}
  },
  BatchGetCommand: class {
    constructor(public params: any) {}
  },
}));

import { getProfileVacancies, getProfilePosts, getProfileBookmarks } from "./activity";

describe("profile activity handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
  });

  describe("getProfileVacancies", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getProfileVacancies({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return user vacancies list on success", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-1",
            empresaUuid: "comp-1",
            titulo: "Dev",
            company: "Comp 1",
            fechaCreacion: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "VACANCY#job-2",
            empresaUuid: "other-comp",
            titulo: "Other Dev",
          },
        ],
      });

      const res = await getProfileVacancies(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe("job-1");
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Vacancies error"));
      const res = await getProfileVacancies(
        { pathParameters: { id: "comp-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getProfilePosts", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getProfilePosts({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return user posts with interaction relations", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#post-1",
            author: "Alice",
            content: "Hello world",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            PK: "POST#post-2",
            author: "Alice",
            content: "Second post",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }); // Query user posts

      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { SK: "LIKE#u-2" },
          { SK: "BOOKMARK#u-3" },
          {
            SK: "COMMENT#c-1",
            author: "Bob",
            content: "Nice!",
            isDeleted: true,
          },
        ],
      }); // Query post 2 interactions

      mockDynamoSend.mockResolvedValueOnce({
        Items: [],
      }); // Query post 1 interactions

      const res = await getProfilePosts(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data).toHaveLength(2);
      expect(data.data[0].uniqueId).toBe("post-2");
      expect(data.data[0].likesList).toContain("u-2");
      expect(data.data[0].bookmarksList).toContain("u-3");
      expect(data.data[0].comments[0].isDeleted).toBe(true);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Posts error"));
      const res = await getProfilePosts(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe("getProfileBookmarks", () => {
    it("should return 400 if id is missing", async () => {
      const res = await getProfileBookmarks({ pathParameters: {} } as any, {} as any, () => {});
      expect(res.statusCode).toBe(400);
    });

    it("should return bookmarked posts sorted and enriched", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "POST#post-1",
            fechaInteraccion: "2026-01-02T00:00:00.000Z",
          },
          {
            PK: "POST#post-2",
          },
        ],
      }); // Query bookmarks

      mockDynamoSend.mockResolvedValueOnce({
        Responses: {
          "jobnet-jobs-prod": [
            {
              PK: "POST#post-1",
              SK: "METADATA",
              author: "Alice",
              content: "Bookmarked post",
            },
            {
              PK: "POST#post-2",
              SK: "METADATA",
              author: "Bob",
              content: "Second bookmark",
            },
          ],
        },
      }); // BatchGetCommand posts

      mockDynamoSend.mockResolvedValueOnce({
        Items: [],
      }); // Query post 1 interactions
      mockDynamoSend.mockResolvedValueOnce({
        Items: [],
      }); // Query post 2 interactions

      const res = await getProfileBookmarks(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data).toHaveLength(2);
      expect(data.data[0].uniqueId).toBe("post-1");
    });

    it("should return 403 Forbidden if another user tries to access private bookmarks", async () => {
      const res = await getProfileBookmarks(
        {
          pathParameters: { id: "u-1" },
          headers: { "x-user-id": "intruder-999" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(403);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("Por directivas de privacidad y protección de datos");
    });

    it("should allow privileged moderator/admin to inspect bookmarks", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });
      const res = await getProfileBookmarks(
        {
          pathParameters: { id: "u-1" },
          headers: { "x-user-id": "mod-1", "x-user-role": "MODERATOR" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
    });

    it("should return bookmarked vacancies when user has saved job vacancies", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "VACANCY#job-1",
            GSI1SK: "VACANCY#job-1",
            fechaInteraccion: "2026-01-05T00:00:00.000Z",
          },
        ],
      }); // Query bookmarks

      mockDynamoSend.mockResolvedValueOnce({
        Responses: {
          "jobnet-jobs-prod": [
            {
              PK: "VACANCY#job-1",
              SK: "METADATA",
              titulo: "Senior Cloud Engineer",
              company: "Tech Corp",
              salario: 65000,
              modalidad: "Remoto",
            },
          ],
        },
      }); // BatchGetCommand vacancies

      mockDynamoSend.mockResolvedValueOnce({
        Items: [{ SK: "LIKE#user-viewer" }, { SK: "BOOKMARK#u-1" }],
      }); // Query vacancy relations

      const res = await getProfileBookmarks(
        {
          pathParameters: { id: "u-1" },
          queryStringParameters: { type: "jobs" },
        } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe("job-1");
      expect(data.data[0].title).toBe("Senior Cloud Engineer");
      expect(data.data[0].likesList).toContain("user-viewer");
      expect(data.data[0].likesCount).toBe(1);
      expect(data.jobs).toHaveLength(1);
    });

    it("should return 500 on database error", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("Bookmarks error"));
      const res = await getProfileBookmarks(
        { pathParameters: { id: "u-1" } } as any,
        {} as any,
        () => {},
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
