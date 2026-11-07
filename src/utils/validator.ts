import { z } from "zod";
import { APIGatewayProxyResult } from "aws-lambda";

export const defaultCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Content-Type": "application/json",
};

/**
 * Parses raw Lambda body string safely.
 * Returns 400 Bad Request if syntax is malformed instead of throwing a 500.
 */
export function parseJsonBody<T = any>(
  rawBody: string | null | undefined,
  headers: Record<string, any> = defaultCorsHeaders,
): { success: true; data: T } | { success: false; response: APIGatewayProxyResult } {
  if (rawBody === null || rawBody === undefined || rawBody === "") {
    return { success: true, data: {} as T };
  }

  if (typeof rawBody === "object") {
    return { success: true, data: rawBody as T };
  }

  try {
    const data = JSON.parse(rawBody);
    return { success: true, data };
  } catch {
    return {
      success: false,
      response: {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Sintaxis JSON inválida en el cuerpo de la solicitud.",
          code: "INVALID_JSON",
        }),
      },
    };
  }
}

/**
 * Validates arbitrary data against a Zod schema.
 * Formats validation issues clearly and returns a 400 Bad Request response on failure.
 */
export function validateSchema<T>(
  data: unknown,
  schema: z.ZodType<T>,
  headers: Record<string, any> = defaultCorsHeaders,
): { success: true; data: T } | { success: false; response: APIGatewayProxyResult } {
  const result = schema.safeParse(data);
  if (!result.success) {
    const formattedErrors = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return {
        field: field || "root",
        message: issue.message,
      };
    });

    return {
      success: false,
      response: {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Error de validación en los datos enviados.",
          code: "VALIDATION_ERROR",
          details: formattedErrors,
        }),
      },
    };
  }

  return { success: true, data: result.data };
}

/**
 * Combines safe JSON parsing and Zod schema validation in a single call.
 */
export function validateAndParse<T>(
  rawBody: string | null | undefined,
  schema: z.ZodType<T>,
  headers: Record<string, any> = defaultCorsHeaders,
): { success: true; data: T } | { success: false; response: APIGatewayProxyResult } {
  const parseResult = parseJsonBody(rawBody, headers);
  if (!parseResult.success) {
    return parseResult;
  }
  return validateSchema(parseResult.data, schema, headers);
}

// ---------------------------------------------------------------------------
// Common reusable Zod primitives preventing injection, DoS and corruption
// ---------------------------------------------------------------------------

/**
 * Identifier safe from Single-Table Design delimiter injection (disallows '#')
 */
export const safeIdSchema = z
  .string()
  .trim()
  .min(1, "El identificador no puede estar vacío.")
  .max(128, "El identificador excede la longitud máxima permitida.")
  .regex(/^[^#]+$/, "El identificador no puede contener caracteres delimitadores '#'.");

/**
 * Sanitized string with min/max length guards against DynamoDB 400KB limit
 */
export const safeText = (min = 0, max = 5000) =>
  z
    .string()
    .trim()
    .min(min, `Debe contener al menos ${min} caracteres.`)
    .max(max, `No debe exceder ${max} caracteres.`);

/**
 * Non-negative currency or price value
 */
export const nonNegativeNumber = (max = 1_000_000_000) =>
  z
    .union([z.number(), z.string()])
    .transform((val) => (typeof val === "string" ? Number(val) : val))
    .pipe(
      z
        .number({ message: "Debe ser un número válido." })
        .nonnegative("El valor no puede ser negativo.")
        .max(max, `El valor no debe exceder ${max}.`)
        .refine((val) => !isNaN(val), {
          message: "Debe ser un número válido.",
        }),
    );

/**
 * Positive integer (e.g. for page limits, vacancies available)
 */
export const positiveInteger = (min = 1, max = 10_000) =>
  z
    .union([z.number(), z.string()])
    .transform((val) => (typeof val === "string" ? Number(val) : val))
    .pipe(
      z
        .number({ message: "Debe ser un número válido." })
        .int("Debe ser un número entero.")
        .min(min, `El valor mínimo es ${min}.`)
        .max(max, `El valor máximo es ${max}.`)
        .refine((val) => !isNaN(val), {
          message: "Debe ser un número válido.",
        }),
    );

/**
 * Safe enums used across JobNet
 */
export const modalidadEnum = z.enum(
  ["Presencial", "Híbrido", "Hibrido", "Remoto", "PRESENCIAL", "HIBRIDO", "REMOTO"],
  { message: "Modalidad inválida. Debe ser Presencial, Híbrido o Remoto." },
);

export const estadoVacanteEnum = z.enum(
  ["Activa", "Pausada", "Cerrada", "ACTIVA", "PAUSADA", "CERRADA"],
  {
    message: "Estado de vacante inválido. Debe ser Activa, Pausada o Cerrada.",
  },
);

export const userRoleEnum = z.enum(
  ["CANDIDATO", "ORGANIZACION", "EMPRESA", "ADMIN", "MODERATOR", "MODERADOR"],
  { message: "Rol de usuario inválido." },
);
