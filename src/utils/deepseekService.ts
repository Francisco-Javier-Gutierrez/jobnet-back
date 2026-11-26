/**
 * Servicio Centralizado de Inteligencia Artificial (DeepSeek / OpenAI Compatible) para JobNet.
 * Proporciona:
 * 1. Moderación semántica y multimodal (Texto de vacantes, publicaciones, comentarios e imágenes).
 * 2. Motor de Razonamiento, Comparación y Ranking de Candidatos para el ATS de Vacantes.
 *
 * Configurable dinámicamente mediante variables de entorno (aiConfig).
 */

import {
  getAiProvider,
  getAiModel,
  getAiApiKey,
  getAiApiUrl,
  DEFAULT_DEEPSEEK_API_KEY,
  DEFAULT_DEEPSEEK_API_URL,
} from "./aiConfig";

export { DEFAULT_DEEPSEEK_API_KEY };

export interface ModerationAiResult {
  safe: boolean;
  confidence: number;
  flaggedCategories: string[];
  reason: string | null;
}

export interface CandidateRankingInput {
  candidateId: string;
  name: string;
  titularProfesional?: string;
  bio?: string;
  skills?: string[];
  experience?: any[];
  education?: any[];
  coverLetter?: string;
}

export interface VacancyRankingInput {
  id: string;
  title: string;
  description: string;
  requirements?: string | string[];
  skills?: string[];
  modality?: string;
  salary?: string;
}

export interface CandidateAiMatch {
  candidateId: string;
  name: string;
  titularProfesional: string;
  matchPercentage: number;
  tier: "TOP_MATCH" | "FUERTE_CANDIDATO" | "AJUSTE_MODERADO" | "BAJO_AJUSTE";
  tierLabel: string;
  strengths: string[];
  gaps: string[];
  justification: string;
}

export interface VacancyAiRankingResult {
  jobId: string;
  jobTitle: string;
  totalEvaluated: number;
  evaluatedAt: string;
  ranking: CandidateAiMatch[];
  summary: string;
}

export const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || DEFAULT_DEEPSEEK_API_URL;
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export function getDeepSeekApiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY?.trim() || undefined;
}

/**
 * Moderación de texto con DeepSeek / OpenAI API (Vacantes, Publicaciones y Comentarios).
 */
export async function moderateTextWithDeepSeek(
  text: string,
  context: "VACANCY" | "POST" | "COMMENT" = "POST",
): Promise<ModerationAiResult> {
  const apiKey = getAiApiKey("moderation", "deepseek") || getDeepSeekApiKey();
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const model = getAiModel("moderation", "deepseek");
  const apiUrl = getAiApiUrl("moderation", "deepseek");

  const prompt = `
Eres el motor de moderación y cumplimiento normativo de JobNet (plataforma profesional de empleo y comunidad laboral).
Analiza el siguiente texto en contexto de "${context}".

Políticas estrictas:
1. DISCRIMINACION LABORAL (especialmente en ofertas de empleo / VACANCY): Rechaza restricciones injustificadas de género ("solo mujeres/hombres"), edad máxima arbitraria ("máximo 28 años", "menor de 30"), exigencia de "buena presentación" / "apariencia física", estado civil o embarazo.
2. ESTAFAS LABORALES Y FRAUDES: Rechaza ofertas que requieran inversión previa del candidato, depósitos para uniformes, trámites o exámenes, o esquemas piramidales / cripto.
3. DISCURSO DE ODIO: Prohibido cualquier ataque o degradación por raza, origen, religión, orientación sexual o discapacidad.
4. ACOSO Y VIOLENCIA: Prohibido hostigamiento, amenazas o agresión personal.
5. CONTENIDO SEXUALMENTE EXPLÍCITO (NSFW): Prohibido terminantemente contenido pornográfico, menciones directas a actos sexuales, prostitución o escorts en esta plataforma profesional.

Texto a analizar:
"""${text}"""

Responde ÚNICAMENTE con un objeto JSON válido con este esquema exacto:
{
  "safe": boolean,
  "confidence": number,
  "flaggedCategories": string[],
  "reason": string or null
}
`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente de moderación de contenido estricto. Siempre respondes únicamente en formato JSON válido.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.0,
      }),
    });

    if (!response.ok) {
      console.error(`DeepSeek API error [${response.status}]:`, await response.text());
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const data = (await response.json()) as any;
    const rawContent = data?.choices?.[0]?.message?.content;
    if (!rawContent) {
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const parsed = JSON.parse(rawContent);
    return {
      safe: Boolean(parsed.safe),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.95,
      flaggedCategories: Array.isArray(parsed.flaggedCategories) ? parsed.flaggedCategories : [],
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error("Error invoking DeepSeek text moderation:", error);
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}

/**
 * Moderación de imágenes con DeepSeek / OpenAI Multimodal API (base64 data URL).
 */
export async function moderateImageWithDeepSeek(
  imageInput: Buffer | string,
  mimeType: string = "image/jpeg",
): Promise<ModerationAiResult> {
  const apiKey = getAiApiKey("moderation", "deepseek") || getDeepSeekApiKey();
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const model = getAiModel("moderation", "deepseek");
  const apiUrl = getAiApiUrl("moderation", "deepseek");

  const base64Data = Buffer.isBuffer(imageInput)
    ? imageInput.toString("base64")
    : imageInput.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");

  const dataUri = `data:${mimeType};base64,${base64Data}`;

  const prompt = `
Analiza esta imagen subida a la plataforma profesional de empleo JobNet.
Políticas estrictas de moderación:
1. NSFW / CONTENIDO SEXUAL: Desnudez explícita, lencería no laboral, poses sugerentes de contenido para adultos.
2. VIOLENCIA / GORE: Armas, sangre, agresiones o material gráfico perturbador.
3. SÍMBOLOS DE ODIO: Esvásticas, símbolos extremistas o grupos de odio.
4. TEXTO INCORPORADO OFENSIVO / MEMES: Lee el texto incrustado y verifica que no contenga insultos, acoso o estafas.

Responde ÚNICAMENTE con este JSON exacto:
{
  "safe": boolean,
  "confidence": number,
  "flaggedCategories": string[],
  "reason": string or null
}
`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Eres un moderador de visión artificial. Responde únicamente en formato JSON.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.0,
      }),
    });

    if (!response.ok) {
      console.error(`DeepSeek Image API error [${response.status}]:`, await response.text());
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const data = (await response.json()) as any;
    const rawContent = data?.choices?.[0]?.message?.content;
    if (!rawContent) {
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const parsed = JSON.parse(rawContent);
    return {
      safe: Boolean(parsed.safe),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.95,
      flaggedCategories: Array.isArray(parsed.flaggedCategories) ? parsed.flaggedCategories : [],
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error("Error invoking DeepSeek image moderation:", error);
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}

/**
 * Moderación de documentos y PDFs con DeepSeek.
 */
export async function moderateDocumentWithDeepSeek(
  pdfInput: Buffer | string,
  extractedText?: string,
): Promise<ModerationAiResult> {
  if (extractedText && extractedText.trim().length > 0) {
    return moderateTextWithDeepSeek(
      `Documento adjunto profesional:\n${extractedText.substring(0, 4000)}`,
      "POST",
    );
  }

  const rawText = Buffer.isBuffer(pdfInput)
    ? pdfInput.toString("utf-8").replace(/[^\x20-\x7E\n]/g, " ")
    : String(pdfInput);

  return moderateTextWithDeepSeek(`Documento profesional:\n${rawText.substring(0, 3000)}`, "POST");
}

/**
 * Motor ATS con IA: Genera la tabla comparativa de candidatos para una vacante,
 * calculando el porcentaje de afinidad y una justificación técnica profesional.
 * Soporta cualquier proveedor y modelo de razonamiento configurado en .env
 * (DeepSeek, OpenAI, Gemini, etc.).
 */
export async function rankCandidatesForVacancyWithAi(
  vacancy: VacancyRankingInput,
  candidates: CandidateRankingInput[],
): Promise<VacancyAiRankingResult> {
  const now = new Date().toISOString();

  if (!candidates || candidates.length === 0) {
    return {
      jobId: vacancy.id,
      jobTitle: vacancy.title,
      totalEvaluated: 0,
      evaluatedAt: now,
      ranking: [],
      summary: "No hay candidatos postulados actualmente para esta vacante.",
    };
  }

  const provider = getAiProvider("reasoning");
  const apiKey = getAiApiKey("reasoning", provider) || getDeepSeekApiKey();
  const model = getAiModel("reasoning", provider);
  const apiUrl = getAiApiUrl("reasoning", provider);

  if (!apiKey) {
    return generateFallbackRanking(vacancy, candidates, now, "Evaluación básica completada.");
  }

  const candidatesDataForPrompt = candidates.map((c, i) => ({
    indice: i + 1,
    candidateId: c.candidateId,
    name: c.name,
    titular: c.titularProfesional || "Sin titular",
    bio: c.bio || "",
    skills: c.skills || [],
    experienceCount: Array.isArray(c.experience) ? c.experience.length : 0,
    experienceHighlights: Array.isArray(c.experience)
      ? c.experience
          .slice(0, 3)
          .map((e: any) => `${e.puesto || e.cargo || "Puesto"} en ${e.empresa || ""}`)
          .join("; ")
      : "",
    coverLetterExcerpt: c.coverLetter ? c.coverLetter.substring(0, 250) : "",
  }));

  const systemPrompt = `
Eres un Consultor Senior de Reclutamiento y Selección de Talento (ATS AI) en JobNet.
Tu objetivo es analizar una vacante laboral y comparar objetivamente a todos los candidatos postulados.

Reglas de evaluación técnica y objetiva:
1. Asigna un porcentaje de afinidad realista (0 a 100%) a cada candidato en base a:
   - Coincidencia de habilidades técnicas clave requeridas vs declaradas.
   - Relevancia de su trayectoria / experiencia profesional frente a las funciones del puesto.
   - Mensaje de presentación y coherencia del perfil.
2. Clasifica a cada candidato en uno de 4 niveles ("tier"):
   - "TOP_MATCH" (85% a 100%): Cumple o supera los requisitos clave con experiencia sólida.
   - "FUERTE_CANDIDATO" (70% a 84%): Cumple la mayoría de requisitos, perfil muy viable.
   - "AJUSTE_MODERADO" (50% a 69%): Cumple parte de los requisitos, pero faltan habilidades clave.
   - "BAJO_AJUSTE" (0% a 49%): Perfil lejano al puesto o sin experiencia afín.
3. Proporciona una justificación concisa (2 a 3 oraciones claras) explicando exactamente por qué se considera así.
4. Identifica de 1 a 3 fortalezas clave ("strengths") y hasta 2 brechas potenciales ("gaps").
5. Ordena la lista de candidatos de mayor a menor porcentaje de coincidencia.

Responde ÚNICAMENTE con un JSON con esta estructura exacta:
{
  "summary": "Breve resumen ejecutivo del pool de candidatos para esta vacante (1 o 2 oraciones)",
  "ranking": [
    {
      "candidateId": "id del candidato",
      "name": "nombre",
      "titularProfesional": "titular",
      "matchPercentage": 92,
      "tier": "TOP_MATCH",
      "strengths": ["Habilidad 1", "Habilidad 2"],
      "gaps": ["Área a explorar en entrevista"],
      "justification": "Explicación concisa y profesional del ajuste."
    }
  ]
}
`;

  const userPrompt = `
VACANTE A EVALUAR:
- Título: ${vacancy.title}
- Descripción: ${vacancy.description}
- Requisitos: ${Array.isArray(vacancy.requirements) ? vacancy.requirements.join(", ") : vacancy.requirements || "No especificados"}
- Habilidades Requeridas: ${vacancy.skills?.join(", ") || "No especificadas"}
- Modalidad: ${vacancy.modality || "No especificada"}

CANDIDATOS POSTULADOS (${candidates.length}):
${JSON.stringify(candidatesDataForPrompt, null, 2)}
`;

  if (provider === "gemini") {
    try {
      const geminiUrl = `${apiUrl}/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
          },
        }),
      });

      if (!response.ok) {
        console.error(`Gemini ATS Ranking error [${response.status}]:`, await response.text());
        throw new Error(`Gemini API error status: ${response.status}`);
      }

      const data = (await response.json()) as any;
      const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawContent) {
        throw new Error("No response content from Gemini ATS ranking.");
      }

      const parsed = JSON.parse(rawContent);
      return formatRankingResponse(vacancy, parsed, now);
    } catch (err: any) {
      console.error("Error generating Gemini ATS ranking:", err);
      return generateFallbackRanking(vacancy, candidates, now);
    }
  }

  // DeepSeek u OpenAI-compatible
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error(`ATS Ranking error [${response.status}]:`, await response.text());
      throw new Error(`AI API error status: ${response.status}`);
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("No response content from ATS ranking.");
    }

    const parsed = JSON.parse(content);
    return formatRankingResponse(vacancy, parsed, now);
  } catch (err: any) {
    console.error("Error generating ATS ranking:", err);
    return generateFallbackRanking(vacancy, candidates, now);
  }
}

/**
 * Alias retrocompatible para rankCandidatesForVacancyWithAi
 */
export const rankCandidatesForVacancyWithDeepSeek = rankCandidatesForVacancyWithAi;

function formatRankingResponse(
  vacancy: VacancyRankingInput,
  parsed: any,
  now: string,
): VacancyAiRankingResult {
  const rawRanking: any[] = Array.isArray(parsed.ranking) ? parsed.ranking : [];

  const tierLabels: Record<string, string> = {
    TOP_MATCH: "Top Match",
    FUERTE_CANDIDATO: "Fuerte Candidato",
    AJUSTE_MODERADO: "Ajuste Moderado",
    BAJO_AJUSTE: "Bajo Ajuste",
  };

  const formattedRanking: CandidateAiMatch[] = rawRanking.map((item) => {
    const matchPct = Math.min(100, Math.max(0, Math.round(Number(item.matchPercentage) || 50)));
    const tier =
      item.tier &&
      ["TOP_MATCH", "FUERTE_CANDIDATO", "AJUSTE_MODERADO", "BAJO_AJUSTE"].includes(item.tier)
        ? item.tier
        : matchPct >= 85
          ? "TOP_MATCH"
          : matchPct >= 70
            ? "FUERTE_CANDIDATO"
            : matchPct >= 50
              ? "AJUSTE_MODERADO"
              : "BAJO_AJUSTE";

    return {
      candidateId: item.candidateId,
      name: item.name,
      titularProfesional: item.titularProfesional || "Candidato",
      matchPercentage: matchPct,
      tier,
      tierLabel: tierLabels[tier] || "Ajuste Moderado",
      strengths: Array.isArray(item.strengths) ? item.strengths : [],
      gaps: Array.isArray(item.gaps) ? item.gaps : [],
      justification:
        item.justification || "Evaluado por IA en base a los requerimientos del puesto.",
    };
  });

  // Ordenar explícitamente de mayor a menor porcentaje
  formattedRanking.sort((a, b) => b.matchPercentage - a.matchPercentage);

  return {
    jobId: vacancy.id,
    jobTitle: vacancy.title,
    totalEvaluated: formattedRanking.length,
    evaluatedAt: now,
    ranking: formattedRanking,
    summary: parsed.summary || "Análisis comparativo de candidatos generado exitosamente con IA.",
  };
}

function generateFallbackRanking(
  vacancy: VacancyRankingInput,
  candidates: CandidateRankingInput[],
  now: string,
  summaryText?: string,
): VacancyAiRankingResult {
  const vacancySkills = (vacancy.skills || []).map((s) => s.toLowerCase());
  const fallbackList: CandidateAiMatch[] = candidates.map((c, idx) => {
    const cSkills = (c.skills || []).map((s) => s.toLowerCase());
    const common = vacancySkills.filter((vs) => cSkills.includes(vs));
    const matchPct =
      vacancySkills.length > 0
        ? Math.round((common.length / vacancySkills.length) * 100)
        : Math.max(50, 95 - idx * 10);
    const tier =
      matchPct >= 80 ? "TOP_MATCH" : matchPct >= 60 ? "FUERTE_CANDIDATO" : "AJUSTE_MODERADO";

    return {
      candidateId: c.candidateId,
      name: c.name,
      titularProfesional: c.titularProfesional || "Candidato",
      matchPercentage: matchPct,
      tier,
      tierLabel:
        tier === "TOP_MATCH"
          ? "Top Match"
          : tier === "FUERTE_CANDIDATO"
            ? "Fuerte Candidato"
            : "Ajuste Moderado",
      strengths: common.length > 0 ? common : c.skills?.slice(0, 3) || ["Perfil afín"],
      gaps: [],
      justification:
        common.length > 0
          ? `Coincidencia técnica directa en ${common.length} habilidades clave requeridas para la vacante.`
          : "Evaluación preliminar basada en perfil registrado.",
    };
  });

  fallbackList.sort((a, b) => b.matchPercentage - a.matchPercentage);

  return {
    jobId: vacancy.id,
    jobTitle: vacancy.title,
    totalEvaluated: fallbackList.length,
    evaluatedAt: now,
    ranking: fallbackList,
    summary: summaryText || "Comparativa generada con base en afinidad de habilidades.",
  };
}
