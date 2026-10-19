/**
 * Motor orquestador de Pre-Filtrado determinístico (Nivel 0) para JobNet.
 * Se ejecuta en memoria en < 2ms por llamada y previene llamadas innecesarias a la IA.
 */

import { normalizeForModeration } from "./textNormalizer";
import { PROFANITY_CATEGORIES } from "./profanityDictionary";

export interface PreAiFilterResult {
  isClean: boolean;
  matches: string[];
  categories: string[];
  highestSeverity: "ALTA" | "CRITICA" | "MEDIA" | null;
  normalizedSnippet?: string;
  explanation?: string;
}

// Pre-compilación de expresiones regulares para máxima velocidad de ejecución en Lambda
interface CompiledRule {
  categoryId: string;
  categoryName: string;
  severity: "ALTA" | "CRITICA" | "MEDIA";
  term: string;
  regex: RegExp;
  isAcronym: boolean;
}

const COMPILED_RULES: CompiledRule[] = [];

// Inicialización de reglas compiladas una sola vez al cargar el módulo
for (const cat of PROFANITY_CATEGORIES) {
  const isAcronymCat = cat.id === "ACRONYMS";
  for (const rawTerm of cat.terms) {
    const term = rawTerm.trim().toLowerCase();
    if (!term) continue;

    if (isAcronymCat) {
      // Para acrónimos: Coincidencia como palabra completa (\b) o separado por puntos/espacios/guiones
      // Ej: s.y.b.a.u, s y b a u, sybau
      const spacedPattern = term.split("").join("[\\s\\._\\-\\*,]*");
      const regex = new RegExp(`(^|[^a-z0-9ñ])(${spacedPattern})([^a-z0-9ñ]|$)`, "i");
      COMPILED_RULES.push({
        categoryId: cat.id,
        categoryName: cat.name,
        severity: cat.severity,
        term,
        regex,
        isAcronym: true,
      });
    } else if (term.includes(" ")) {
      // Frase multi-palabra (ej. estafas o frases compuestas)
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(^|[^a-z0-9ñ])${escaped}([^a-z0-9ñ]|$)`, "i");
      COMPILED_RULES.push({
        categoryId: cat.id,
        categoryName: cat.name,
        severity: cat.severity,
        term,
        regex,
        isAcronym: false,
      });
    } else {
      // Término léxico individual: Exige límite de palabra para evitar falsos positivos
      // ej: "computadora" no debe coincidir con "puto", "asistente" no debe coincidir con "ass"
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(^|[^a-z0-9ñ])${escaped}([^a-z0-9ñ]|$)`, "i");
      COMPILED_RULES.push({
        categoryId: cat.id,
        categoryName: cat.name,
        severity: cat.severity,
        term,
        regex,
        isAcronym: false,
      });
    }
  }
}

/**
 * Evalúa un texto antes de invocar cualquier modelo de Inteligencia Artificial.
 * Si detecta ofensas obvias, acrónimos de odio o leetspeak tóxico, retorna isClean: false.
 *
 * @param rawText Texto a evaluar (título, descripción, comentario, etc.)
 */
export function evaluatePreAi(rawText: string): PreAiFilterResult {
  if (!rawText || typeof rawText !== "string" || rawText.trim() === "") {
    return {
      isClean: true,
      matches: [],
      categories: [],
      highestSeverity: null,
    };
  }

  // 1. Normalización y de-leetspeak
  const { normalized, squashed } = normalizeForModeration(rawText);

  const matchedTerms = new Set<string>();
  const matchedCategories = new Set<string>();
  let highestSeverity: "ALTA" | "CRITICA" | null = null;

  // 2. Comprobación contra reglas compiladas
  for (const rule of COMPILED_RULES) {
    let hasMatch = false;

    // A. Comprobar contra el texto normalizado con límites de palabra
    if (rule.regex.test(normalized)) {
      hasMatch = true;
    }

    // B. Si es acrónimo, comprobar también si aparece exactamente en el texto squashed
    // (ej: si escribieron "s.y.b.a.u." o "v_t_a_l_v" sin espacios)
    if (!hasMatch && rule.isAcronym) {
      if (squashed === rule.term || squashed.includes(rule.term)) {
        // Para evitar que acrónimos cortos como 'alv' maten palabras naturales como 'salvar' o 'calvo',
        // verificamos que la longitud del término sea al menos 4 caracteres o coincida con el regex de separación
        if (rule.term.length >= 4 || rule.regex.test(rawText.toLowerCase())) {
          hasMatch = true;
        }
      }
    }

    if (hasMatch) {
      matchedTerms.add(rule.term);
      matchedCategories.add(rule.categoryName);
      if (rule.severity === "CRITICA") {
        highestSeverity = "CRITICA";
      } else if (!highestSeverity) {
        highestSeverity = "ALTA";
      }
    }
  }

  const matches = Array.from(matchedTerms);
  const categories = Array.from(matchedCategories);
  const isClean = matches.length === 0;

  let explanation: string | undefined = undefined;
  if (!isClean) {
    explanation = `Contenido bloqueado por el filtro de seguridad: se detectaron términos o acrónimos no permitidos (${matches.slice(0, 3).join(", ")}).`;
  }

  return {
    isClean,
    matches,
    categories,
    highestSeverity,
    normalizedSnippet: normalized.length > 100 ? `${normalized.substring(0, 100)}...` : normalized,
    explanation,
  };
}
