import { describe, it, expect } from "vitest";
import {
  formatSalary,
  getEstadoBadge,
  formatUbicacion,
  enrichJobItem,
  enrichProfileItem,
} from "./dtoEnricher";

describe("dtoEnricher utility", () => {
  describe("formatSalary", () => {
    it("should return 'A convenir' for 0 or negative salary", () => {
      expect(formatSalary(0)).toBe("A convenir");
      expect(formatSalary(undefined)).toBe("A convenir");
      expect(formatSalary(-100)).toBe("A convenir");
    });

    it("should format positive salaries cleanly", () => {
      expect(formatSalary(25000)).toBe("$25,000 MXN / mes");
    });
  });

  describe("getEstadoBadge", () => {
    it("should return emerald badge for Activa", () => {
      const badge = getEstadoBadge("Activa");
      expect(badge.badgeColor).toBe("emerald");
      expect(badge.label).toBe("Publicada");
    });

    it("should return amber badge for EVALUACION", () => {
      const badge = getEstadoBadge("EVALUACION");
      expect(badge.badgeColor).toBe("amber");
      expect(badge.label).toBe("Bajo Evaluación");
    });

    it("should return rose badge for CERRADA", () => {
      const badge = getEstadoBadge("CERRADA");
      expect(badge.badgeColor).toBe("rose");
      expect(badge.label).toBe("Cerrada");
    });
  });

  describe("formatUbicacion", () => {
    it("should return sector if present", () => {
      expect(formatUbicacion({ sector: "Polanco, CDMX" })).toBe(
        "Polanco, CDMX",
      );
    });

    it("should format coordinates if lat/lng are provided", () => {
      expect(
        formatUbicacion({ ubicacion: { lat: 19.4326, lng: -99.1332 } }),
      ).toBe("Coordenadas (19.4326, -99.1332)");
    });

    it("should fallback to 'Ubicación no especificada'", () => {
      expect(formatUbicacion({})).toBe("Ubicación no especificada");
    });
  });

  describe("enrichJobItem", () => {
    it("should enrich job item with view properties", () => {
      const rawJob = {
        PK: "VACANCY#job-123",
        titulo: "Desarrollador Fullstack",
        salario: 35000,
        estado: "Activa",
        sector: "Tecnología",
      };

      const enriched = enrichJobItem(rawJob);
      expect(enriched.id).toBe("job-123");
      expect(enriched.title).toBe("Desarrollador Fullstack");
      expect(enriched.salarioFormatted).toBe("$35,000 MXN / mes");
      expect(enriched.estadoBadge.badgeColor).toBe("emerald");
      expect(enriched.ubicacionFormatted).toBe("Tecnología");
    });

    it("should include userContext when appliedJobsMap is provided", () => {
      const rawJob = {
        PK: "VACANCY#job-123",
        titulo: "Dev",
        estado: "Activa",
      };

      const appliedMap = new Map([
        ["job-123", { applicationId: "user-1", status: "PENDIENTE" }],
      ]);

      const enriched = enrichJobItem(rawJob, appliedMap);
      expect(enriched.userContext).toBeDefined();
      expect(enriched.userContext?.isApplied).toBe(true);
      expect(enriched.userContext?.canApply).toBe(false);
    });
  });

  describe("enrichProfileItem", () => {
    it("should normalize arrays and compute completeness", () => {
      const rawProfile = {
        nombre: "Juan Pérez",
        bio: "Desarrollador",
        habilidades: ["Vue", "Node"],
      };

      const enriched = enrichProfileItem(rawProfile);
      expect(Array.isArray(enriched.experiencia)).toBe(true);
      expect(Array.isArray(enriched.educacion)).toBe(true);
      expect(enriched.hasCv).toBe(false);
      expect(enriched.completenessPercentage).toBeGreaterThan(0);
    });
  });
});
