import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIGatewayProxyEvent } from "aws-lambda";

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
  QueryCommand: class {},
  ScanCommand: class {},
}));

import { getAdminAnalytics } from "./analytics";

describe("getAdminAnalytics handler (Panel de Analítica Avanzada [V2])", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createEvent = (
    role: string = "ADMIN",
    queryStringParameters: Record<string, string> | null = null,
  ): APIGatewayProxyEvent => {
    return {
      headers: {
        "x-user-role": role,
      },
      queryStringParameters,
      body: null,
      isBase64Encoded: false,
      pathParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
      path: "/admin/analytics",
      httpMethod: "GET",
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
    };
  };

  it("should deny access with 403 if user is not ADMIN", async () => {
    const event = createEvent("CANDIDATO");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body);
    expect(body.error).toContain("Panel de analítica exclusivo para Administradores");
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("should deny access with 403 if user is MODERATOR", async () => {
    const event = createEvent("MODERATOR");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(403);
  });

  it("should allow access and return metrics when called by ADMIN", async () => {
    // 1. Vacancies Query result
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "VACANCY#v1",
          habilidadesRequeridas: ["Vue 3", "TypeScript", "Tailwind CSS"],
          location: "Toluca, Estado de México",
          modalidad: "Híbrido",
          estado: "ACTIVO",
        },
        {
          PK: "VACANCY#v2",
          habilidadesRequeridas: ["Vue 3", "AWS", "Node.js"],
          location: "Metepec, Estado de México",
          modalidad: "Remoto",
          estado: "ACTIVO",
        },
      ],
    });

    // 2. Organizations Query result
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#org1",
          tipoUsuario: "ORGANIZACION",
          fechaCreacion: "2026-08-10T10:00:00Z",
          organizacionVerificada: true,
        },
        {
          PK: "USER#org2",
          tipoUsuario: "ORGANIZACION",
          fechaCreacion: "2026-09-15T12:00:00Z",
          organizacionVerificada: false,
        },
      ],
    });

    // 3. Application Scan Count
    mockDynamoSend.mockResolvedValueOnce({
      Count: 45,
    });

    const event = createEvent("ADMIN");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    // Verify Top 10 Technical Skills
    expect(body.data.topSkills).toBeDefined();
    expect(Array.isArray(body.data.topSkills)).toBe(true);
    expect(body.data.topSkills.length).toBeLessThanOrEqual(10);
    expect(body.data.topSkills[0]).toHaveProperty("name");
    expect(body.data.topSkills[0]).toHaveProperty("count");
    expect(body.data.topSkills[0]).toHaveProperty("percentage");

    // Verify Monthly Organizations Volume
    expect(body.data.monthlyOrganizations).toBeDefined();
    expect(Array.isArray(body.data.monthlyOrganizations)).toBe(true);
    expect(body.data.monthlyOrganizations.length).toBeGreaterThan(0);
    expect(body.data.monthlyOrganizations[0]).toHaveProperty("month");
    expect(body.data.monthlyOrganizations[0]).toHaveProperty("count");

    // Verify Application Rate per job offer
    expect(body.data.applicationRate).toBeDefined();
    expect(body.data.applicationRate).toHaveProperty("averagePerJob");
    expect(body.data.applicationRate).toHaveProperty("byModality");
    expect(body.data.applicationRate).toHaveProperty("totalApplications");

    // Verify KPIs
    expect(body.data.kpis).toBeDefined();
    expect(body.data.kpis).toHaveProperty("totalVacancies");
    expect(body.data.kpis).toHaveProperty("totalOrganizations");
  });

  it("should filter metrics by region when region query parameter is provided", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "VACANCY#v1",
          habilidadesRequeridas: ["Python", "Docker"],
          location: "Toluca, Estado de México",
          modalidad: "Presencial",
          estado: "ACTIVO",
        },
        {
          PK: "VACANCY#v2",
          habilidadesRequeridas: ["React", "AWS"],
          location: "Guadalajara, Jalisco",
          modalidad: "Presencial",
          estado: "ACTIVO",
        },
      ],
    });

    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    mockDynamoSend.mockResolvedValueOnce({ Count: 10 });

    const event = createEvent("ADMIN", { region: "Toluca" });
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.selectedRegion).toBe("Toluca");
  });

  it("should handle DynamoDB failures gracefully with fallback data", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB connection failed"));

    const event = createEvent("ADMIN");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    // Even if Dynamo fails, it catches and provides base analytics
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data.topSkills.length).toBeGreaterThan(0);
    expect(body.data.anomalies.length).toBeGreaterThan(0);
  });

  it("should detect anomalous concurrency of > 10 vacancies in < 1h", async () => {
    const now = Date.now();
    // 12 vacancies created in the last 30 minutes by org-bot
    const spamVacancies = Array.from({ length: 12 }, (_, i) => ({
      PK: `VACANCY#spam-${i}`,
      empresaUuid: "org-bot-999",
      company: "Bot Network S.A.",
      fechaCreacion: new Date(now - i * 2 * 60 * 1000).toISOString(),
      habilidadesRequeridas: ["TypeScript"],
      estado: "ACTIVO",
    }));

    mockDynamoSend.mockResolvedValueOnce({ Items: spamVacancies }); // Vacancies
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Orgs
    mockDynamoSend.mockResolvedValueOnce({ Count: 5 }); // Apps
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Incidents

    const event = createEvent("ADMIN");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    const detected = body.data.anomalies.find((a: any) => a.organizationId === "org-bot-999");
    expect(detected).toBeDefined();
    expect(detected.type).toBe("RAPID_VACANCIES");
    expect(detected.category).toBe("BOT_SPAM");
    expect(detected.count).toBe(12);
    expect(detected.threshold).toBe(10);
  });

  it("should detect anomalous concurrency of > 5 reports in < 1h", async () => {
    const now = Date.now();
    // 6 incidents created in the last 20 minutes for org-fraud
    const fraudIncidents = Array.from({ length: 6 }, (_, i) => ({
      PK: `INCIDENT#fraud-${i}`,
      companyId: "org-fraud-888",
      companyName: "Fraude Inversiones",
      fechaCreacion: new Date(now - i * 3 * 60 * 1000).toISOString(),
    }));

    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Vacancies
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Orgs
    mockDynamoSend.mockResolvedValueOnce({ Count: 5 }); // Apps
    mockDynamoSend.mockResolvedValueOnce({ Items: fraudIncidents }); // Incidents

    const event = createEvent("ADMIN");
    const result: any = await getAdminAnalytics(event, {} as any, () => {});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    const detected = body.data.anomalies.find((a: any) => a.organizationId === "org-fraud-888");
    expect(detected).toBeDefined();
    expect(detected.type).toBe("REPORT_SURGE");
    expect(detected.category).toBe("MASS_FRAUD");
    expect(detected.count).toBe(6);
    expect(detected.threshold).toBe(5);
  });
});
