import { describe, it, expect, vi, afterEach } from "vitest";

describe("profile common", () => {
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
    expect(common.headers).toBeDefined();
  });

  it("should initialize with local endpoint clients when IS_OFFLINE is true", async () => {
    process.env.IS_OFFLINE = "true";
    vi.resetModules();
    const common = await import("./common");
    expect(common.isOffline).toBe(true);
  });

  it("should enrich posts with full and default relation values", async () => {
    const { enrichPostsWithRelations } = await import("./common");

    // Empty array branch
    const empty = await enrichPostsWithRelations([], {} as any, "table");
    expect(empty).toEqual([]);

    // Mock client
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { SK: "LIKE#user-1" },
          { SK: "BOOKMARK#user-2" },
          {
            SK: "COMMENT#2026-01-01",
            parentId: "parent-1",
            author: "Author 1",
            content: "Hello",
            createdAt: "2026-01-01",
            isDeleted: false,
          },
          {
            SK: "COMMENT#2026-01-02",
            // default fallbacks for comment
          },
        ],
      }),
    };

    const post1 = {
      PK: "POST#uuid-1",
      author: "Alice",
      role: "Empresa",
      authorUuid: "u-1",
      fotoPerfil: "https://pic.jpg",
      content: "Post content",
      media: "https://media.jpg",
      pdfUrl: "https://doc.pdf",
      pdfName: "doc.pdf",
      createdAt: "2026-01-01",
      sharesCount: 5,
    };

    const post2 = {
      PK: "POST#uuid-2",
      // default fallbacks for post with no fotoPerfil or authorAvatar
    };

    const results = await enrichPostsWithRelations([post1, post2], mockClient, "table");
    expect(results).toHaveLength(2);
    expect(results[0].uniqueId).toBe("uuid-1");
    expect(results[0].likesList).toContain("user-1");
    expect(results[0].bookmarksList).toContain("user-2");
    expect(results[0].comments).toHaveLength(2);
    expect(results[1].author).toBe("Anónimo");
    expect(results[1].role).toBe("Candidato");
    expect(results[1].fotoPerfil).toBeUndefined();
    expect(results[1].sharesCount).toBe(0);

    // Null Items test & unhandled SK test
    const mockClientNullItems = {
      send: vi.fn().mockResolvedValue({
        Items: [{ SK: "UNKNOWN#123" }],
      }),
    };
    const results2 = await enrichPostsWithRelations(
      [{ PK: "POST#uuid-3" }],
      mockClientNullItems,
      "table",
    );
    expect(results2).toHaveLength(1);
    expect(results2[0].likesList).toHaveLength(0);

    // Completely empty Items (result.Items = undefined)
    const mockClientUndef = {
      send: vi.fn().mockResolvedValue({}),
    };
    const results3 = await enrichPostsWithRelations(
      [{ PK: "POST#uuid-4" }],
      mockClientUndef,
      "table",
    );
    expect(results3).toHaveLength(1);
  });

  it("should enrich jobs with relations including likesList, bookmarksList and commentsCount", async () => {
    const { enrichJobsWithRelations } = await import("./common");

    // Empty array branch
    const empty = await enrichJobsWithRelations([], {} as any, "table");
    expect(empty).toEqual([]);

    // Mock client with relations
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { SK: "LIKE#user-100" },
          { SK: "BOOKMARK#user-200" },
          {
            SK: "COMMENT#2026-01-01",
            content: "Excelente oportunidad",
            isDeleted: false,
          },
          {
            SK: "COMMENT#2026-01-02",
            isDeleted: true,
          },
        ],
      }),
    };

    const job1 = {
      PK: "VACANCY#job-1",
      titulo: "Arquitecto Cloud",
      company: "Tech Corp",
      salario: 80000,
      modalidad: "Remoto",
      sharesCount: 3,
    };

    const results = await enrichJobsWithRelations([job1], mockClient, "table");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("job-1");
    expect(results[0].likesList).toContain("user-100");
    expect(results[0].likesCount).toBe(1);
    expect(results[0].bookmarksList).toContain("user-200");
    expect(results[0].bookmarksCount).toBe(1);
    expect(results[0].commentsCount).toBe(1);
    expect(results[0].sharesCount).toBe(3);

    // Error handling branch in query
    const failingClient = {
      send: vi.fn().mockRejectedValue(new Error("DynamoDB error")),
    };
    const fallbackResults = await enrichJobsWithRelations(
      [{ PK: "VACANCY#job-err", titulo: "Dev" }],
      failingClient,
      "table",
    );
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0].likesList).toHaveLength(0);
    expect(fallbackResults[0].likesCount).toBe(0);
  });
});
