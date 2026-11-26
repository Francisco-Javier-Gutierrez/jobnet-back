/**
 * Configuración Centralizada para Servicios de Inteligencia Artificial (JobNet).
 * Permite alternar dinámicamente entre proveedores (DeepSeek, Gemini, OpenAI, etc.),
 * configurar URLs base, claves de API y separar los modelos utilizados para moderación
 * de contenido vs tareas de razonamiento avanzado y ATS (resúmenes y ranking de candidatos).
 *
 * Carga automáticamente variables de entorno desde el archivo .env si está disponible.
 */

import dotenv from "dotenv";
if (process.env.NODE_ENV !== "test") {
  dotenv.config();
}

export type AiProvider = "deepseek" | "gemini" | "openai" | string;
export type AiTaskType = "moderation" | "reasoning";

export const DEFAULT_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
export const DEFAULT_DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
export const DEFAULT_GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Obtiene el proveedor de IA configurado para una tarea específica.
 * Prioridad de resolución:
 * 1. AI_MODERATION_PROVIDER o AI_REASONING_PROVIDER (según tipo de tarea)
 * 2. AI_PROVIDER (global)
 * 3. Si sólo GEMINI_API_KEY está definida en el entorno (y no DEEPSEEK_API_KEY), infiere "gemini"
 * 4. Por defecto: "deepseek"
 */
export function getAiProvider(task: AiTaskType = "moderation"): AiProvider {
  if (task === "moderation" && process.env.AI_MODERATION_PROVIDER) {
    return process.env.AI_MODERATION_PROVIDER.toLowerCase().trim();
  }
  if (task === "reasoning" && process.env.AI_REASONING_PROVIDER) {
    return process.env.AI_REASONING_PROVIDER.toLowerCase().trim();
  }
  if (process.env.AI_PROVIDER) {
    return process.env.AI_PROVIDER.toLowerCase().trim();
  }
  if (process.env.GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    return "gemini";
  }
  return "deepseek";
}

/**
 * Obtiene el modelo de IA específico para la tarea solicitada.
 * Permite separar modelos ligeros y rápidos para moderación (ej. deepseek-chat, gemini-2.0-flash)
 * de modelos de razonamiento profundo para el ATS (ej. deepseek-reasoner, o3-mini, gemini-2.0-pro).
 */
export function getAiModel(task: AiTaskType = "moderation", providerOverride?: AiProvider): string {
  const provider = providerOverride || getAiProvider(task);

  if (task === "moderation") {
    if (process.env.AI_MODERATION_MODEL) {
      return process.env.AI_MODERATION_MODEL.trim();
    }
    if (provider === "gemini") {
      return (
        process.env.GEMINI_MODERATION_MODEL?.trim() ||
        process.env.GEMINI_MODEL?.trim() ||
        "gemini-flash-latest"
      );
    }
    return (
      process.env.DEEPSEEK_MODERATION_MODEL?.trim() ||
      process.env.DEEPSEEK_MODEL?.trim() ||
      "deepseek-chat"
    );
  }

  // task === "reasoning" (ATS Candidate Ranking & Summaries)
  if (process.env.AI_REASONING_MODEL) {
    return process.env.AI_REASONING_MODEL.trim();
  }
  if (process.env.AI_RANKING_MODEL) {
    return process.env.AI_RANKING_MODEL.trim();
  }
  if (provider === "gemini") {
    return (
      process.env.GEMINI_REASONING_MODEL?.trim() ||
      process.env.GEMINI_MODEL?.trim() ||
      "gemini-2.0-flash"
    );
  }
  return (
    process.env.DEEPSEEK_REASONING_MODEL?.trim() ||
    process.env.DEEPSEEK_MODEL?.trim() ||
    "deepseek-chat"
  );
}

/**
 * Obtiene la API Key para la tarea y proveedor solicitado.
 * NUNCA tiene claves quemadas en código fuente; lee estrictamente de variables de entorno.
 */
export function getAiApiKey(
  task: AiTaskType = "moderation",
  providerOverride?: AiProvider,
): string | undefined {
  const provider = providerOverride || getAiProvider(task);

  if (task === "moderation" && process.env.AI_MODERATION_API_KEY) {
    return process.env.AI_MODERATION_API_KEY.trim();
  }
  if (task === "reasoning" && process.env.AI_REASONING_API_KEY) {
    return process.env.AI_REASONING_API_KEY.trim();
  }
  if (process.env.AI_API_KEY) {
    return process.env.AI_API_KEY.trim();
  }

  if (provider === "gemini") {
    return (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY)?.trim();
  }

  // deepseek o compatible openai
  return process.env.DEEPSEEK_API_KEY?.trim() || process.env.AI_API_KEY?.trim() || undefined;
}

/**
 * Obtiene la URL del endpoint para la tarea y proveedor solicitado.
 */
export function getAiApiUrl(
  task: AiTaskType = "moderation",
  providerOverride?: AiProvider,
): string {
  const provider = providerOverride || getAiProvider(task);

  if (task === "moderation" && process.env.AI_MODERATION_API_URL) {
    return process.env.AI_MODERATION_API_URL.trim();
  }
  if (task === "reasoning" && process.env.AI_REASONING_API_URL) {
    return process.env.AI_REASONING_API_URL.trim();
  }
  if (process.env.AI_API_URL) {
    return process.env.AI_API_URL.trim();
  }

  if (provider === "gemini") {
    return process.env.GEMINI_API_URL?.trim() || DEFAULT_GEMINI_API_URL;
  }

  return process.env.DEEPSEEK_API_URL?.trim() || DEFAULT_DEEPSEEK_API_URL;
}
