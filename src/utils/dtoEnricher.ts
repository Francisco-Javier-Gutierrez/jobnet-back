export interface JobItemInput {
  PK?: string;
  id?: string;
  titulo?: string;
  title?: string;
  company?: string;
  empresaUuid?: string;
  ubicacion?: { lat?: number; lng?: number };
  lat?: number;
  lng?: number;
  modalidad?: string;
  salario?: number;
  habilidadesRequeridas?: string[];
  sectores?: string[];
  descripcion?: string;
  pdfUrl?: string;
  pdfName?: string;
  estado?: string;
  fechaCreacion?: string;
  createdAt?: string;
  sector?: string;
  salarioConfidencial?: boolean;
  isSalaryConfidential?: boolean;
  municipio?: string;
  location?: string;
  preguntasFiltro?: string[];
  screeningQuestions?: string[];
  fechaCierre?: string;
  fechaVigencia?: string;
  alertaCaducidadEnviada?: boolean;
  alertaAltaDemandaEnviada?: boolean;
  [key: string]: any;
}

export interface EnrichedJobItem {
  id: string;
  title: string;
  company: string;
  empresaUuid: string;
  lat: number;
  lng: number;
  modalidad: string;
  salario: number;
  salarioFormatted: string;
  salarioConfidencial?: boolean;
  isSalaryConfidential?: boolean;
  municipio?: string;
  location?: string;
  preguntasFiltro?: string[];
  screeningQuestions?: string[];
  habilidadesRequeridas: string[];
  sectores: string[];
  descripcion: string;
  pdfUrl: string;
  pdfName?: string;
  estado: string;
  estadoBadge: {
    code: string;
    label: string;
    badgeColor: string;
    icon: string;
  };
  ubicacionFormatted: string;
  createdAt: string;
  fechaCierre?: string;
  fechaVigencia?: string;
  diasParaVencer?: number;
  alertaCaducidadEnviada?: boolean;
  alertaAltaDemandaEnviada?: boolean;
  userContext?: {
    isApplied: boolean;
    applicationId: string | null;
    applicationStatus: string | null;
    isBookmarked: boolean;
    canApply: boolean;
  };
  [key: string]: any;
}

export function formatSalary(salario?: number, isConfidential?: boolean): string {
  if (isConfidential) {
    return "Salario confidencial";
  }
  if (!salario || salario <= 0) {
    return "A convenir";
  }
  return `$${salario.toLocaleString("es-MX")} MXN / mes`;
}

export function getEstadoBadge(estado?: string) {
  const code = (estado || "Activa").toUpperCase();
  switch (code) {
    case "EVALUACION":
    case "EN_REVISION":
      return {
        code: "EVALUACION",
        label: "Bajo Evaluación",
        badgeColor: "amber",
        icon: "hourglass_empty",
      };
    case "CERRADA":
    case "INACTIVA":
      return {
        code: "CERRADA",
        label: "Cerrada",
        badgeColor: "rose",
        icon: "lock",
      };
    case "SUSPENDIDA":
      return {
        code: "SUSPENDIDA",
        label: "Suspendida",
        badgeColor: "rose",
        icon: "block",
      };
    case "ACTIVA":
    default:
      return {
        code: "ACTIVA",
        label: "Publicada",
        badgeColor: "emerald",
        icon: "check_circle",
      };
  }
}

export function formatUbicacion(item: JobItemInput): string {
  if (item.sector) return item.sector;
  const lat = item.ubicacion?.lat ?? item.lat;
  const lng = item.ubicacion?.lng ?? item.lng;
  if (lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)) {
    return `Coordenadas (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
  }
  return "Ubicación no especificada";
}

export function enrichJobItem(
  item: JobItemInput,
  appliedJobsMap?: Map<string, { applicationId: string; status: string }>,
  bookmarkedJobIds?: Set<string>,
): EnrichedJobItem {
  const id = item.id || (item.PK ? item.PK.replace("VACANCY#", "") : "");
  const title = item.titulo || item.title || "Sin título";
  const company = item.company || "Empresa";
  const estado = item.estado || "Activa";

  const isApplied = appliedJobsMap ? appliedJobsMap.has(id) : false;
  const applicationData = appliedJobsMap ? appliedJobsMap.get(id) : null;
  const isBookmarked = bookmarkedJobIds ? bookmarkedJobIds.has(id) : false;

  const isSalaryConfidential = Boolean(
    item.salarioConfidencial || item.isSalaryConfidential,
  );
  const preguntasFiltro = Array.isArray(item.preguntasFiltro)
    ? item.preguntasFiltro
    : Array.isArray(item.screeningQuestions)
      ? item.screeningQuestions
      : [];
  const municipio =
    item.municipio ||
    (item.location ? item.location.replace(", Estado de México", "").trim() : "Toluca");
  const location =
    item.location || (municipio ? `${municipio}, Estado de México` : "Estado de México");
  const sector = item.sector || (item.sectores && item.sectores[0]) || "General";

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const createdAt = item.fechaCreacion || item.createdAt || new Date().toISOString();
  const fechaCierre =
    item.fechaCierre ||
    item.fechaVigencia ||
    new Date(new Date(createdAt).getTime() + 30 * ONE_DAY_MS).toISOString();
  const diasParaVencer = Math.ceil(
    (new Date(fechaCierre).getTime() - Date.now()) / ONE_DAY_MS,
  );

  const enriched: EnrichedJobItem = {
    ...item,
    id,
    title,
    company,
    empresaUuid: item.empresaUuid || "",
    lat: item.ubicacion?.lat ?? item.lat ?? 0,
    lng: item.ubicacion?.lng ?? item.lng ?? 0,
    modalidad: item.modalidad || "Presencial",
    salario: item.salario || 0,
    salarioFormatted: formatSalary(item.salario, isSalaryConfidential),
    salarioConfidencial: isSalaryConfidential,
    isSalaryConfidential,
    municipio,
    location,
    sector,
    preguntasFiltro,
    screeningQuestions: preguntasFiltro,
    habilidadesRequeridas: item.habilidadesRequeridas || [],
    sectores: item.sectores || [],
    descripcion: item.descripcion || "Sin descripción",
    pdfUrl: item.pdfUrl || "",
    pdfName: item.pdfName || "",
    aptitudes: item.aptitudes || "",
    experienciaAnos: item.experienciaAnos || 0,
    estado,
    estadoBadge: getEstadoBadge(estado),
    ubicacionFormatted: formatUbicacion(item),
    createdAt,
    fechaCierre,
    fechaVigencia: fechaCierre,
    diasParaVencer,
    alertaCaducidadEnviada: Boolean(item.alertaCaducidadEnviada),
    alertaAltaDemandaEnviada: Boolean(item.alertaAltaDemandaEnviada),
  };

  if (appliedJobsMap !== undefined || bookmarkedJobIds !== undefined) {
    enriched.userContext = {
      isApplied,
      applicationId: applicationData?.applicationId || null,
      applicationStatus: applicationData?.status || null,
      isBookmarked,
      canApply: estado.toUpperCase() === "ACTIVA" && !isApplied,
    };
  }

  return enriched;
}

export function enrichProfileItem(item: any): any {
  if (!item) return null;

  const experiencia = Array.isArray(item.experiencia) ? item.experiencia : [];
  const educacion = Array.isArray(item.educacion) ? item.educacion : [];
  const habilidades = Array.isArray(item.habilidades) ? item.habilidades : [];
  const habilidadesCertificadas = Array.isArray(item.habilidadesCertificadas)
    ? item.habilidadesCertificadas
    : [];
  const portafolio = Array.isArray(item.portafolio) ? item.portafolio : [];

  // Calculate profile completeness
  let filledFields = 0;
  const totalFields = 6;

  if (item.nombre || item.name) filledFields++;
  if (item.bio || item.biografia) filledFields++;
  if (item.fotoPerfil || item.avatarUrl) filledFields++;
  if (item.cvUrl || item.cvPdfUrl) filledFields++;
  if (habilidades.length > 0) filledFields++;
  if (experiencia.length > 0) filledFields++;

  const completenessPercentage = Math.round((filledFields / totalFields) * 100);

  return {
    ...item,
    experiencia,
    educacion,
    habilidades,
    habilidadesCertificadas,
    portafolio,
    documentosAdicionales:
      item.documentosAdicionales || item.documentosProfesionales || [],
    documentosProfesionales:
      item.documentosProfesionales || item.documentosAdicionales || [],
    links:
      item.links ||
      (item.enlacesWeb && typeof item.enlacesWeb === "object"
        ? Object.entries(item.enlacesWeb).map(([label, url]) => ({
            label,
            url,
          }))
        : []),
    enlacesWeb: item.enlacesWeb || item.links || {},
    fotoPerfil: item.fotoPerfil || item.avatarUrl || "",
    cvUrl: item.cvUrl || item.cvPdfUrl || "",
    cvName: item.cvName || (item.cvUrl ? "Currículum.pdf" : ""),
    hasCv: Boolean(item.cvUrl || item.cvPdfUrl),
    completenessPercentage,
  };
}
