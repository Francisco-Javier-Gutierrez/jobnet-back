export interface DetectedAnomaly {
  id: string;
  type: "RAPID_VACANCIES" | "REPORT_SURGE";
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  organizationId: string;
  organizationName: string;
  count: number;
  threshold: number;
  timeWindow: string;
  detectedAt: string;
  title: string;
  description: string;
  category: "BOT_SPAM" | "MASS_FRAUD";
  status: "ACTIVE" | "DISMISSED" | "RESOLVED";
}

export const BASELINE_ANOMALIES: DetectedAnomaly[] = [];

export function detectAnomalousConcurrency(
  vacanciesItems: any[] = [],
  incidentItems: any[] = [],
): DetectedAnomaly[] {
  const oneHourMs = 60 * 60 * 1000;
  const detectedAnomalies: DetectedAnomaly[] = [];

  // 1. Analyze vacancies concurrency per organization (< 1 hour window, threshold > 10)
  const orgVacanciesMap: Record<string, { companyName: string; dates: number[] }> = {};

  vacanciesItems.forEach((vac) => {
    const orgId = vac.empresaUuid || vac.companyId || vac.company || "unknown";
    const orgName = vac.company || vac.empresaNombre || "Organización";
    const createdAtStr = vac.fechaCreacion || vac.createdAt;
    if (createdAtStr) {
      const time = new Date(createdAtStr).getTime();
      if (!isNaN(time)) {
        if (!orgVacanciesMap[orgId]) {
          orgVacanciesMap[orgId] = { companyName: orgName, dates: [] };
        }
        orgVacanciesMap[orgId].dates.push(time);
      }
    }
  });

  Object.entries(orgVacanciesMap).forEach(([orgId, data]) => {
    data.dates.sort((a, b) => a - b);
    for (let i = 0; i < data.dates.length; i++) {
      const windowStart = data.dates[i];
      const windowEnd = windowStart + oneHourMs;
      const countInWindow = data.dates.filter((d) => d >= windowStart && d <= windowEnd).length;
      if (countInWindow > 10) {
        detectedAnomalies.push({
          id: `anom-vac-${orgId}`,
          type: "RAPID_VACANCIES",
          severity: "CRITICAL",
          organizationId: orgId,
          organizationName: data.companyName,
          count: countInWindow,
          threshold: 10,
          timeWindow: "< 1 hora",
          detectedAt: new Date(windowStart).toISOString(),
          title: "Posible Bot / Spam de Vacantes Masivo",
          description: `Se detectaron ${countInWindow} vacantes publicadas en un periodo menor a una hora por "${data.companyName}". Supera el umbral de seguridad de 10 vacantes/hora.`,
          category: "BOT_SPAM",
          status: "ACTIVE",
        });
        break;
      }
    }
  });

  // 2. Analyze reports concurrency per organization (< 1 hour window, threshold > 5)
  const orgReportsMap: Record<string, { companyName: string; dates: number[] }> = {};

  incidentItems.forEach((inc) => {
    const orgId = inc.companyId || inc.empresaUuid || inc.targetId || "unknown";
    const orgName = inc.companyName || inc.targetTitle || "Organización";
    const createdAtStr = inc.fechaCreacion || inc.createdAt;
    if (createdAtStr) {
      const time = new Date(createdAtStr).getTime();
      if (!isNaN(time)) {
        if (!orgReportsMap[orgId]) {
          orgReportsMap[orgId] = { companyName: orgName, dates: [] };
        }
        orgReportsMap[orgId].dates.push(time);
      }
    }
  });

  Object.entries(orgReportsMap).forEach(([orgId, data]) => {
    data.dates.sort((a, b) => a - b);
    for (let i = 0; i < data.dates.length; i++) {
      const windowStart = data.dates[i];
      const windowEnd = windowStart + oneHourMs;
      const countInWindow = data.dates.filter((d) => d >= windowStart && d <= windowEnd).length;
      if (countInWindow > 5) {
        detectedAnomalies.push({
          id: `anom-rep-${orgId}`,
          type: "REPORT_SURGE",
          severity: "CRITICAL",
          organizationId: orgId,
          organizationName: data.companyName,
          count: countInWindow,
          threshold: 5,
          timeWindow: "< 1 hora",
          detectedAt: new Date(windowStart).toISOString(),
          title: "Avalancha de Denuncias / Sospecha de Fraude Masivo",
          description: `Se acumularon ${countInWindow} reportes de usuarios en menos de una hora contra "${data.companyName}". Supera el umbral de seguridad de 5 reportes/hora.`,
          category: "MASS_FRAUD",
          status: "ACTIVE",
        });
        break;
      }
    }
  });

  return detectedAnomalies;
}
