/**
 * Normalizador y De-Ofuscador de texto para filtros Pre-IA en JobNet.
 * Diseñado para ejecutarse en < 2ms dentro de funciones AWS Lambda sin asignación pesada de memoria.
 */

// Mapeo de homóglifos (caracteres cirílicos, griegos o similares usados para spoofing)
const HOMOGLYPHS_MAP: Record<string, string> = {
  // Cirílico minúsculas y mayúsculas
  а: "a",
  А: "a",
  в: "b",
  В: "b",
  с: "c",
  С: "c",
  е: "e",
  Е: "e",
  о: "o",
  О: "o",
  р: "p",
  Р: "p",
  ѕ: "s",
  Ѕ: "s",
  і: "i",
  І: "i",
  ј: "j",
  Ј: "j",
  у: "y",
  У: "y",
  х: "x",
  Х: "x",
  һ: "h",
  Һ: "h",
  // Griego
  α: "a",
  Α: "a",
  β: "b",
  Β: "b",
  ε: "e",
  Ε: "e",
  ι: "i",
  Ι: "i",
  κ: "k",
  Κ: "k",
  ο: "o",
  Ο: "o",
  ρ: "p",
  Ρ: "p",
  τ: "t",
  Τ: "t",
  υ: "u",
  Υ: "u",
  χ: "x",
  Χ: "x",
};

// Mapeo de números y símbolos a letras (Leetspeak)
const LEETSPEAK_MAP: Record<string, string> = {
  "@": "a",
  "4": "a",
  "8": "b",
  "3": "e",
  "1": "i",
  "!": "i",
  "|": "i",
  "¡": "i",
  "0": "o",
  "5": "s",
  $: "s",
  "7": "t",
  "+": "t",
};

/**
 * Normaliza una cadena de texto eliminando caracteres invisibles y resolviendo homóglifos.
 */
export function removeInvisiblesAndHomoglyphs(text: string): string {
  if (!text) return "";

  // 1. Normalización Unicode NFC y eliminación de Zero-Width y caracteres de control
  const cleaned = text
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g, "");

  // 2. Reemplazo de homóglifos
  let result = "";
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    result += HOMOGLYPHS_MAP[char] || char;
  }

  return result;
}

/**
 * Remueve acentos y diacríticos preservando intencionalmente la letra ñ para distinguir año/ano.
 */
export function stripAccentsPreservingN(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, (match, offset, str) => {
      // Si el carácter anterior es N o n y la tilde es virgulilla (~, \u0303), lo dejamos como ñ
      const prevChar = str[offset - 1];
      if ((prevChar === "n" || prevChar === "N") && match === "\u0303") {
        return match;
      }
      return "";
    })
    .normalize("NFC");
}

/**
 * Traduce caracteres de leetspeak común a sus equivalentes alfabéticos.
 */
export function deLeet(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    result += LEETSPEAK_MAP[char] || char;
  }
  return result;
}

/**
 * Colapsa repeticiones fonéticas exageradas (ej: "peeeendeeejooo" -> "pendejo", "vttallvv" -> "vtalv").
 * Convierte 3 o más repeticiones consecutivas a 1 sola letra.
 */
export function collapseRepeatedChars(text: string): string {
  return text.replace(/(.)\1{2,}/gi, "$1");
}

/**
 * Pipeline completo de normalización para análisis léxico.
 * Retorna:
 * - normalized: Texto en minúsculas, sin acentos, sin leetspeak, con espacios limpios.
 * - squashed: Texto sin ningún espacio ni puntuación (ideal para acrónimos).
 */
export function normalizeForModeration(rawText: string): {
  normalized: string;
  squashed: string;
} {
  if (!rawText) {
    return { normalized: "", squashed: "" };
  }

  // 1. Quitar invisibles y sustituir homóglifos
  let processed = removeInvisiblesAndHomoglyphs(rawText.toLowerCase());

  // 2. Quitar acentos preservando ñ
  processed = stripAccentsPreservingN(processed);

  // 3. Resolver leetspeak (@ -> a, 3 -> e, 1 -> i, 0 -> o, $ -> s, etc.)
  processed = deLeet(processed);

  // 4. Colapsar repeticiones excesivas (3 o más letras iguales -> 1 letra)
  processed = collapseRepeatedChars(processed);

  // 5. Eliminar símbolos/puntuación de evasión incrustados entre letras (ej: p*u*t*o -> puto, s.y.b.a.u -> sybau)
  processed = processed.replace(
    /([a-z0-9ñ])[._\-*#/\\~^'`"|?!,]+(?=[a-z0-9ñ])/gi,
    "$1",
  );

  // 6. Colapsar secuencias de letras individuales separadas por espacios (ej: "p u t o" -> "puto", "s y b a u" -> "sybau")
  processed = processed.replace(
    /(?:^|\s)([a-z0-9ñ]\s+){2,}[a-z0-9ñ](?=\s|$)/gi,
    (match) => match.replace(/\s+/g, ""),
  );

  // 7. Versión normalizada con espacios limpios
  const normalized = processed.replace(/\s+/g, " ").trim();

  // 8. Versión colapsada total (sin espacios ni puntuación)
  const squashed = processed.replace(/[^a-z0-9ñ]/gi, "");

  return {
    normalized,
    squashed,
  };
}
