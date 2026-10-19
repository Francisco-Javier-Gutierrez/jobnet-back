/**
 * Servicio de Moderación Multimodal con Inteligencia Artificial (Nivel 1) para JobNet.
 * Utiliza Google Gemini 2.0 Flash / Flash-Lite mediante fetch nativo de Node 20.
 * Costo: 1,500 peticiones diarias gratis (Free Tier), después $0.075 / 1M tokens.
 */

export interface ModerationAiResult {
  safe: boolean;
  confidence: number; // 0.0 a 1.0
  flaggedCategories: string[]; // ["HATE_SPEECH", "DISCRIMINATION", "HARASSMENT", "SCAM", "PROFANITY", "NSFW", "VIOLENCE"]
  reason: string | null;
}

const DEFAULT_MODEL = "gemini-2.0-flash";
const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Obtiene la API Key de Gemini desde variables de entorno.
 */
function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
}

/**
 * Moderación semántica de texto para vacantes laborales, publicaciones o comentarios.
 * Evalúa discriminación laboral (edad, género, apariencia), odio sutil, acoso y estafas.
 */
export async function moderateTextWithAi(
  text: string,
  context: "VACANCY" | "POST" | "COMMENT" = "POST",
): Promise<ModerationAiResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    // Modo de desarrollo o sin key: se asume limpio para no bloquear ejecución local
    return {
      safe: true,
      confidence: 1.0,
      flaggedCategories: [],
      reason: null,
    };
  }

  const prompt = `
Eres el motor de moderación de contenido de JobNet (plataforma profesional de empleo y comunidad laboral).
Analiza el siguiente texto en contexto de "${context}".
Políticas estrictas:
1. DISCRIMINACION LABORAL (en vacantes): Rechaza restricciones injustificadas de género ("solo mujeres"), edad máxima arbitraria ("máximo 28 años"), exigencia de "buena presentación/apariencia física", estado civil o embarazo.
2. DISCURSO DE ODIO: Prohibido cualquier ataque o degradación por raza, origen, orientación sexual, religión o discapacidad.
3. ESTAFAS LABORALES: Prohibido ofertas que requieran inversión previa, depósitos para uniformes/exámenes o esquemas piramidales/cripto.
4. ACOSO Y VIOLENCIA: Prohibido hostigamiento o amenazas personales.

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
    const url = `${API_BASE_URL}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;
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
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const data = (await response.json()) as any;
    const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
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
 * Moderación de imágenes (fotos de perfil, logos corporativos, adjuntos de publicaciones).
 * Evalúa pornografía/NSFW, violencia/sangre, símbolos de odio y memes ofensivos vía OCR integrado.
 */
export async function moderateImageWithAi(
  imageInput: Buffer | string,
  mimeType: string = "image/jpeg",
): Promise<ModerationAiResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  const base64Data = Buffer.isBuffer(imageInput)
    ? imageInput.toString("base64")
    : imageInput.replace(/^data:image\/[a-zA-Z]+;base64,/, "");

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
    const url = `${API_BASE_URL}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;
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
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const data = (await response.json()) as any;
    const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
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
 * Moderación de documentos PDF (Currículums vitae, especificaciones, constancias RFC).
 * Soporta análisis de texto extraído localmente (pdf-parse) o documento binario directo.
 */
export async function moderateDocumentWithAi(
  pdfInput: Buffer | string,
  extractedText?: string,
): Promise<ModerationAiResult> {
  // 1. Si tenemos el texto extraído, evaluamos vía texto para máxima velocidad y menor consumo
  if (extractedText && extractedText.trim().length > 0) {
    return moderateTextWithAi(
      `Documento adjunto (CV o especificación):\n${extractedText.substring(0, 4000)}`,
      "POST",
    );
  }

  // 2. Si es binario PDF directo, Gemini soporta application/pdf nativamente en inlineData
  const apiKey = getApiKey();
  if (!apiKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

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
    const url = `${API_BASE_URL}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;
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
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
    }

    const data = (await response.json()) as any;
    const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
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
