import request from "supertest";
import app from "./app";

describe("Express Application Entrypoint", () => {
  it("GET /health returns 200 and healthy status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      environment: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it("GET / returns 200 and API service info", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "JobNet Core API",
      version: "2.0.0",
      status: "online",
      architecture: "Express + AWS Lambda Serverless",
    });
  });

  it("Returns 404 for undefined routes", async () => {
    const res = await request(app).get("/non-existent-endpoint-xyz");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Ruta no encontrada");
    expect(res.body).toHaveProperty("path", "/non-existent-endpoint-xyz");
  });

  it("Matches /ai/cooldown and does NOT return 404 Route Not Found", async () => {
    const res = await request(app).get("/ai/cooldown");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it("Matches /jobs/:id/ai-ranking and does NOT return 404 Route Not Found", async () => {
    const res = await request(app).get("/jobs/84bbba42-0f8e-43cb-8d38-12d85c2565f2/ai-ranking");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
