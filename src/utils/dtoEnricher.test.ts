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
    it("should return emerald badge for Activa or default", () => {
      const badge = getEstadoBadge("Activa");
      expect(badge.badgeColor).toBe("emerald");
      expect(badge.label).toBe("Publicada");

      const defaultBadge = getEstadoBadge(undefined);
      expect(defaultBadge.badgeColor).toBe("emerald");
      expect(defaultBadge.label).toBe("Publicada");
    });

    it("should return amber badge for EVALUACION and EN_REVISION", () => {
      const badge1 = getEstadoBadge("EVALUACION");
      expect(badge1.badgeColor).toBe("amber");
      expect(badge1.label).toBe("Bajo Evaluación");

      const badge2 = getEstadoBadge("EN_REVISION");
      expect(badge2.badgeColor).toBe("amber");
      expect(badge2.label).toBe("Bajo Evaluación");
    });

    it("should return rose badge for CERRADA and INACTIVA", () => {
      const badge1 = getEstadoBadge("CERRADA");
      expect(badge1.badgeColor).toBe("rose");
      expect(badge1.label).toBe("Cerrada");

      const badge2 = getEstadoBadge("INACTIVA");
      expect(badge2.badgeColor).toBe("rose");
      expect(badge2.label).toBe("Cerrada");
    });

    it("should return rose badge for SUSPENDIDA", () => {
      const badge = getEstadoBadge("SUSPENDIDA");
      expect(badge.badgeColor).toBe("rose");
      expect(badge.label).toBe("Suspendida");
    });
  });

  describe("formatUbicacion", () => {
    it("should return sector if present", () => {
      expect(formatUbicacion({ sector: "Polanco, CDMX" })).toBe("Polanco, CDMX");
    });

    it("should format coordinates if lat/lng are provided in ubicacion object", () => {
      expect(formatUbicacion({ ubicacion: { lat: 19.4326, lng: -99.1332 } })).toBe(
        "Coordenadas (19.4326, -99.1332)",
      );
      expect(formatUbicacion({ ubicacion: { lat: 19.4326 }, lng: -99.1332 })).toBe(
        "Coordenadas (19.4326, -99.1332)",
      );
    });

    it("should format coordinates if top-level lat/lng are provided", () => {
      expect(formatUbicacion({ lat: 20.1234, lng: -100.5678 })).toBe(
        "Coordenadas (20.1234, -100.5678)",
      );
      expect(formatUbicacion({ lat: 0, lng: -100.5678 })).toBe("Coordenadas (0.0000, -100.5678)");
      expect(formatUbicacion({ lat: 20.1234, lng: 0 })).toBe("Coordenadas (20.1234, 0.0000)");
    });

    it("should fallback to 'Ubicación no especificada' when lat/lng are 0 or missing", () => {
      expect(formatUbicacion({})).toBe("Ubicación no especificada");
      expect(formatUbicacion({ lat: 0, lng: 0 })).toBe("Ubicación no especificada");
      expect(formatUbicacion({ ubicacion: { lat: 0, lng: 0 } })).toBe("Ubicación no especificada");
    });
  });

  describe("enrichJobItem", () => {
    it("should enrich job item with view properties and default values", () => {
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
      expect(enriched.userContext).toBeUndefined();
    });

    it("should fallback to title, id, company defaults when optional fields are omitted", () => {
      const enriched = enrichJobItem({
        id: "custom-id",
        title: "Frontend Lead",
        company: "Acme Corp",
        estado: "CERRADA",
        createdAt: "2026-01-01T00:00:00Z",
      });

      expect(enriched.id).toBe("custom-id");
      expect(enriched.title).toBe("Frontend Lead");
      expect(enriched.company).toBe("Acme Corp");
      expect(enriched.estado).toBe("CERRADA");
      expect(enriched.createdAt).toBe("2026-01-01T00:00:00Z");
    });

    it("should handle empty object fallback for id, title, company, createdAt", () => {
      const enriched = enrichJobItem({});
      expect(enriched.id).toBe("");
      expect(enriched.title).toBe("Sin título");
      expect(enriched.company).toBe("Empresa");
      expect(enriched.estado).toBe("Activa");
      expect(enriched.createdAt).toBeDefined();
    });

    it("should include userContext when appliedJobsMap is provided", () => {
      const rawJob = {
        PK: "VACANCY#job-123",
        titulo: "Dev",
        estado: "Activa",
      };

      const appliedMap = new Map([["job-123", { applicationId: "user-1", status: "PENDIENTE" }]]);

      const enriched = enrichJobItem(rawJob, appliedMap);
      expect(enriched.userContext).toBeDefined();
      expect(enriched.userContext?.isApplied).toBe(true);
      expect(enriched.userContext?.applicationId).toBe("user-1");
      expect(enriched.userContext?.applicationStatus).toBe("PENDIENTE");
      expect(enriched.userContext?.isBookmarked).toBe(false);
      expect(enriched.userContext?.canApply).toBe(false);
    });

    it("should include userContext with bookmarkedJobIds Set", () => {
      const rawJob = {
        id: "job-456",
        title: "DevOps",
        estado: "Activa",
      };

      const bookmarksSet = new Set(["job-456"]);
      const enriched = enrichJobItem(rawJob, undefined, bookmarksSet);
      expect(enriched.userContext).toBeDefined();
      expect(enriched.userContext?.isApplied).toBe(false);
      expect(enriched.userContext?.applicationId).toBeNull();
      expect(enriched.userContext?.isBookmarked).toBe(true);
      expect(enriched.userContext?.canApply).toBe(true);
    });
  });

  describe("enrichProfileItem", () => {
    it("should return null if item is falsy", () => {
      expect(enrichProfileItem(null)).toBeNull();
      expect(enrichProfileItem(undefined)).toBeNull();
    });

    it("should normalize arrays and compute completeness for fully populated profile", () => {
      const rawProfile = {
        nombre: "Juan Pérez",
        bio: "Desarrollador Senior",
        fotoPerfil: "https://example.com/avatar.jpg",
        cvUrl: "https://example.com/cv.pdf",
        cvName: "Mi_CV.pdf",
        habilidades: ["Vue", "Node"],
        habilidadesCertificadas: ["AWS Certified"],
        experiencia: [{ puesto: "Tech Lead", empresa: "Corp" }],
        educacion: [{ institucion: "UNAM", titulo: "Ingeniería" }],
        portafolio: [{ titulo: "Jobnet", url: "https://jobnet.com" }],
        documentosAdicionales: ["doc1.pdf"],
        enlacesWeb: {
          linkedin: "https://linkedin.com/in/juan",
          github: "https://github.com/juan",
        },
      };

      const enriched = enrichProfileItem(rawProfile);
      expect(enriched.experiencia).toHaveLength(1);
      expect(enriched.educacion).toHaveLength(1);
      expect(enriched.habilidades).toHaveLength(2);
      expect(enriched.habilidadesCertificadas).toHaveLength(1);
      expect(enriched.portafolio).toHaveLength(1);
      expect(enriched.documentosAdicionales).toEqual(["doc1.pdf"]);
      expect(enriched.documentosProfesionales).toEqual(["doc1.pdf"]);
      expect(enriched.hasCv).toBe(true);
      expect(enriched.cvName).toBe("Mi_CV.pdf");
      expect(enriched.completenessPercentage).toBe(100);
      expect(enriched.links).toEqual([
        { label: "linkedin", url: "https://linkedin.com/in/juan" },
        { label: "github", url: "https://github.com/juan" },
      ]);
    });

    it("should handle alternative property names: name, biografia, avatarUrl, cvPdfUrl, documentosProfesionales, links array", () => {
      const rawProfile = {
        name: "María Gómez",
        biografia: "Diseñadora UX/UI",
        avatarUrl: "https://example.com/maria.png",
        cvPdfUrl: "https://example.com/maria_cv.pdf",
        documentosProfesionales: ["cert.pdf"],
        links: [{ label: "Portfolio", url: "https://maria.design" }],
      };

      const enriched = enrichProfileItem(rawProfile);
      expect(enriched.fotoPerfil).toBe("https://example.com/maria.png");
      expect(enriched.cvUrl).toBe("https://example.com/maria_cv.pdf");
      expect(enriched.hasCv).toBe(true);
      expect(enriched.cvName).toBe("");
      expect(enriched.documentosAdicionales).toEqual(["cert.pdf"]);
      expect(enriched.links).toEqual([{ label: "Portfolio", url: "https://maria.design" }]);
      expect(enriched.enlacesWeb).toEqual([{ label: "Portfolio", url: "https://maria.design" }]);
    });

    it("should default cvName to Currículum.pdf when cvUrl is present but cvName is missing", () => {
      const enriched = enrichProfileItem({
        cvUrl: "https://example.com/my-cv.pdf",
      });
      expect(enriched.cvName).toBe("Currículum.pdf");
    });

    it("should handle empty profile with zero completeness", () => {
      const enriched = enrichProfileItem({});
      expect(enriched.completenessPercentage).toBe(0);
      expect(enriched.hasCv).toBe(false);
      expect(enriched.cvName).toBe("");
      expect(enriched.links).toEqual([]);
      expect(enriched.documentosAdicionales).toEqual([]);
    });
  });
});
