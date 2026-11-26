/**
 * Servicio Centralizado de Moderación Multimodal con Inteligencia Artificial para JobNet.
 * Permite moderar semánticamente textos (publicaciones, comentarios, ofertas de empleo)
 * y multimedia (imágenes, documentos PDF) usando proveedores dinámicos (DeepSeek, Gemini, OpenAI)
 * configurables totalmente vía variables de entorno (.env).
 */

import {
  getAiProvider,
  getAiModel,
  getAiApiKey,
  getAiApiUrl,
  DEFAULT_DEEPSEEK_API_KEY,
} from "./aiConfig";

import {
  moderateTextWithDeepSeek,
  moderateImageWithDeepSeek,
  moderateDocumentWithDeepSeek,
  rankCandidatesForVacancyWithAi,
  rankCandidatesForVacancyWithDeepSeek,
  ModerationAiResult,
  CandidateRankingInput,
  VacancyRankingInput,
  CandidateAiMatch,
  VacancyAiRankingResult,
} from "./deepseekService";

export {
  moderateTextWithDeepSeek,
  moderateImageWithDeepSeek,
  moderateDocumentWithDeepSeek,
  rankCandidatesForVacancyWithAi,
  rankCandidatesForVacancyWithDeepSeek,
  ModerationAiResult,
  CandidateRankingInput,
  VacancyRankingInput,
  CandidateAiMatch,
  VacancyAiRankingResult,
  DEFAULT_DEEPSEEK_API_KEY,
};

/**
 * Moderación semántica con Gemini API para texto
 */
async function moderateTextWithGemini(
  text: string,
  context: "VACANCY" | "POST" | "COMMENT",
): Promise<ModerationAiResult> {
  const apiKey = getAiApiKey("moderation", "gemini");
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const model = getAiModel("moderation", "gemini");
  const apiUrl = getAiApiUrl("moderation", "gemini");

  const prompt = `
Eres el motor de moderación de contenido de JobNet (plataforma profesional de empleo y comunidad laboral).
Analiza el siguiente texto en contexto de "${context}".
Políticas estrictas:
1. DISCRIMINACION LABORAL (en vacantes): Rechaza restricciones injustificadas de género ("solo mujeres"), edad máxima arbitraria ("máximo 28 años"), exigencia de "buena presentación/apariencia física", estado civil o embarazo.
2. DISCURSO DE ODIO: Prohibido cualquier ataque o degradación por raza, origen, orientación sexual, religión o discapacidad.
3. ESTAFAS LABORALES: Prohibido ofertas que requieran inversión previa, depósitos para uniformes/exámenes o esquemas piramidales/cripto.
4. ACOSO Y VIOLENCIA: Prohibido hostigamiento o amenazas personales.
5. CONTENIDO SEXUAL O EXPLÍCITO (NSFW): Prohibido terminantemente contenido sexualmente explícito, pornografía, menciones directas a actos sexuales (ej. sexo anal, sexo oral), prostitución, escorts o servicios para adultos en esta plataforma profesional.

Texto a analizar:
"""${text}"""

Responde ÚNICAMENTE con un objeto JSON con este esquema exacto:
{
  "safe": boolean,
  "confidence": number,
  "flaggedCategories": string[],
  "reason": string or null
}
`;

  try {
    const url = `${apiUrl}/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.0,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Gemini API error [${response.status}]:`, await response.text());
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const data = (await response.json()) as any;
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "SAFETY" || data?.promptFeedback?.blockReason) {
      return {
        safe: false,
        confidence: 0.99,
        flaggedCategories: ["NSFW", "SEXUAL_CONTENT"],
        reason:
          "El contenido infringe las políticas comunitarias de JobNet sobre contenido para adultos y lenguaje inapropiado.",
      };
    }

    const rawContent = candidate?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const parsed = JSON.parse(rawContent) as ModerationAiResult;
    return {
      safe: Boolean(parsed.safe),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
      flaggedCategories: Array.isArray(parsed.flaggedCategories) ? parsed.flaggedCategories : [],
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error("Error invoking Gemini text moderation:", error);
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}

/**
 * Moderación de imágenes con Gemini API
 */
async function moderateImageWithGemini(
  imageInput: Buffer | string,
  mimeType: string = "image/jpeg",
): Promise<ModerationAiResult> {
  const apiKey = getAiApiKey("moderation", "gemini");
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const model = getAiModel("moderation", "gemini");
  const apiUrl = getAiApiUrl("moderation", "gemini");

  const base64Data = Buffer.isBuffer(imageInput)
    ? imageInput.toString("base64")
    : imageInput.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");

  const prompt = `
Analiza esta imagen subida a JobNet (plataforma profesional de empleo).
Políticas de moderación:
1. NSFW / CONTENIDO SEXUAL: Desnudez explícita, lencería no laboral, poses sugerentes de contenido para adultos.
2. VIOLENCIA / GORE: Armas, sangre, agresiones, material gráfico perturbador.
3. SIMBOLOS DE ODIO: Esvásticas, símbolos de supremacía blanca o grupos de odio.
4. MEMES O TEXTO INCORPORADO OFENSIVO: Lee cualquier texto incrustado en la imagen y evalúa si contiene acoso o insultos.

Responde ÚNICAMENTE con este JSON:
{
  "safe": boolean,
  "confidence": number,
  "flaggedCategories": string[],
  "reason": string or null
}
`;

  try {
    const url = `${apiUrl}/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.0,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Gemini API error [${response.status}]:`, await response.text());
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const data = (await response.json()) as any;
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "SAFETY" || data?.promptFeedback?.blockReason) {
      return {
        safe: false,
        confidence: 0.99,
        flaggedCategories: ["NSFW", "SAFETY_VIOLATION"],
        reason: "La imagen ha sido bloqueada automáticamente por los filtros de seguridad de IA.",
      };
    }

    const rawContent = candidate?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const parsed = JSON.parse(rawContent) as ModerationAiResult;
    return {
      safe: Boolean(parsed.safe),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
      flaggedCategories: Array.isArray(parsed.flaggedCategories) ? parsed.flaggedCategories : [],
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error("Error invoking Gemini image moderation:", error);
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}

/**
 * Moderación de documentos PDF con Gemini API
 */
async function moderateDocumentWithGemini(
  pdfInput: Buffer | string,
  extractedText?: string,
): Promise<ModerationAiResult> {
  if (extractedText && extractedText.trim().length > 0) {
    return moderateTextWithAi(
      `Documento adjunto (CV o especificación):\n${extractedText.substring(0, 4000)}`,
      "POST",
    );
  }

  const apiKey = getAiApiKey("moderation", "gemini");
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const model = getAiModel("moderation", "gemini");
  const apiUrl = getAiApiUrl("moderation", "gemini");

  const base64Data = Buffer.isBuffer(pdfInput)
    ? pdfInput.toString("base64")
    : pdfInput.replace(/^data:application\/pdf;base64,/, "");

  const prompt = `
Analiza este documento PDF subido a la plataforma laboral JobNet (posible CV o documento de postulación).
Evalúa si contiene:
1. Enlaces maliciosos o intentos de phishing evidente.
2. Contenido explícito no relacionado con un entorno laboral o profesional.
3. Difamación o agresiones explícitas.

Responde ÚNICAMENTE con este JSON:
{
  "safe": boolean,
  "confidence": number,
  "flaggedCategories": string[],
  "reason": string or null
}
`;

  try {
    const url = `${apiUrl}/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: base64Data,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.0,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Gemini API error [${response.status}]:`, await response.text());
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const data = (await response.json()) as any;
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "SAFETY" || data?.promptFeedback?.blockReason) {
      return {
        safe: false,
        confidence: 0.99,
        flaggedCategories: ["NSFW", "SAFETY_VIOLATION"],
        reason: "La imagen ha sido bloqueada automáticamente por los filtros de seguridad de IA.",
      };
    }

    const rawContent = candidate?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return {
        safe: true,
        confidence: 0.5,
        flaggedCategories: [],
        reason: null,
      };
    }

    const parsed = JSON.parse(rawContent) as ModerationAiResult;
    return {
      safe: Boolean(parsed.safe),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
      flaggedCategories: Array.isArray(parsed.flaggedCategories) ? parsed.flaggedCategories : [],
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error("Error invoking Gemini document moderation:", error);
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}

/**
 * Moderación semántica de texto para vacantes laborales, publicaciones o comentarios.
 * Utiliza el proveedor configurado en .env (DeepSeek por defecto) con fallback transparente
 * entre DeepSeek y Gemini ante fallos de conexión o cuota.
 */
export async function moderateTextWithAi(
  text: string,
  context: "VACANCY" | "POST" | "COMMENT" = "POST",
): Promise<ModerationAiResult> {
  const provider = getAiProvider("moderation");
  const deepseekKey = getAiApiKey("moderation", "deepseek");
  const geminiKey = getAiApiKey("moderation", "gemini");

  if (provider === "gemini") {
    if (geminiKey) {
      try {
        const geminiResult = await moderateTextWithGemini(text, context);
        if (!geminiResult.safe || geminiResult.confidence >= 0.7) {
          return geminiResult;
        }
      } catch (err) {
        console.warn("Gemini text moderation error, falling back to DeepSeek:", err);
      }
    }

    if (deepseekKey) {
      try {
        return await moderateTextWithDeepSeek(text, context);
      } catch (err) {
        console.warn("DeepSeek fallback text moderation error:", err);
      }
    }
  } else {
    // Proveedor por defecto: deepseek / openai
    if (deepseekKey) {
      try {
        const dsResult = await moderateTextWithDeepSeek(text, context);
        if (!dsResult.safe || dsResult.confidence >= 0.7) {
          return dsResult;
        }
      } catch (err) {
        console.warn("DeepSeek text moderation error, falling back to Gemini:", err);
      }
    }

    if (geminiKey) {
      try {
        return await moderateTextWithGemini(text, context);
      } catch (err) {
        console.warn("Gemini fallback text moderation error:", err);
      }
    }
  }

  // Modo de desarrollo o sin keys configuradas: se asume limpio
  return {
    safe: true,
    confidence: 1.0,
    flaggedCategories: [],
    reason: null,
  };
}

/**
 * Moderación de imágenes (fotos de perfil, logos corporativos, adjuntos de publicaciones).
 * Evalúa pornografía/NSFW, violencia/sangre, símbolos de odio y memes ofensivos vía OCR integrado.
 */
export async function moderateImageWithAi(
  imageInput: Buffer | string,
  mimeType: string = "image/jpeg",
): Promise<ModerationAiResult> {
  const provider = getAiProvider("moderation");
  const deepseekKey = getAiApiKey("moderation", "deepseek");
  const geminiKey = getAiApiKey("moderation", "gemini");

  if (provider === "gemini") {
    if (geminiKey) {
      try {
        const geminiResult = await moderateImageWithGemini(imageInput, mimeType);
        if (!geminiResult.safe || geminiResult.confidence >= 0.7) {
          return geminiResult;
        }
      } catch (err) {
        console.warn("Gemini image moderation error, falling back to DeepSeek:", err);
      }
    }

    if (deepseekKey) {
      try {
        return await moderateImageWithDeepSeek(imageInput, mimeType);
      } catch (err) {
        console.warn("DeepSeek fallback image moderation error:", err);
      }
    }
  } else {
    // deepseek / openai
    if (deepseekKey) {
      try {
        const dsResult = await moderateImageWithDeepSeek(imageInput, mimeType);
        if (!dsResult.safe || dsResult.confidence >= 0.7) {
          return dsResult;
        }
      } catch (err) {
        console.warn("DeepSeek image moderation error, falling back to Gemini:", err);
      }
    }

    if (geminiKey) {
      try {
        return await moderateImageWithGemini(imageInput, mimeType);
      } catch (err) {
        console.warn("Gemini fallback image moderation error:", err);
      }
    }
  }

  return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
}

/**
 * Moderación de documentos PDF (Currículums vitae, especificaciones, constancias RFC).
 * Soporta análisis de texto extraído localmente (pdf-parse) o documento binario directo.
 */
export async function moderateDocumentWithAi(
  pdfInput: Buffer | string,
  extractedText?: string,
): Promise<ModerationAiResult> {
  // Si tenemos texto extraído, evaluamos vía texto para máxima velocidad
  if (extractedText && extractedText.trim().length > 0) {
    return moderateTextWithAi(
      `Documento adjunto (CV o especificación):\n${extractedText.substring(0, 4000)}`,
      "POST",
    );
  }

  const provider = getAiProvider("moderation");
  const deepseekKey = getAiApiKey("moderation", "deepseek");
  const geminiKey = getAiApiKey("moderation", "gemini");

  if (provider === "gemini") {
    if (geminiKey) {
      try {
        const geminiResult = await moderateDocumentWithGemini(pdfInput, extractedText);
        if (!geminiResult.safe || geminiResult.confidence >= 0.7) {
          return geminiResult;
        }
      } catch (err) {
        console.warn("Gemini document moderation error, falling back to DeepSeek:", err);
      }
    }

    if (deepseekKey) {
      try {
        return await moderateDocumentWithDeepSeek(pdfInput, extractedText);
      } catch (err) {
        console.warn("DeepSeek fallback document moderation error:", err);
      }
    }
  } else {
    // deepseek
    if (deepseekKey) {
      try {
        const dsResult = await moderateDocumentWithDeepSeek(pdfInput, extractedText);
        if (!dsResult.safe || dsResult.confidence >= 0.7) {
          return dsResult;
        }
      } catch (err) {
        console.warn("DeepSeek document moderation error, falling back to Gemini:", err);
      }
    }

    if (geminiKey) {
      try {
        return await moderateDocumentWithGemini(pdfInput, extractedText);
      } catch (err) {
        console.warn("Gemini fallback document moderation error:", err);
      }
    }
  }

  return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
}
