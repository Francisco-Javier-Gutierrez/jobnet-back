/**
 * Utilidad para moderación de archivos multimedia (imágenes y PDFs) almacenados en AWS S3
 * mediante el servicio multimodal de Gemini 2.0 Flash / Flash-Lite.
 */

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, bucketName } from "../handlers/jobs/common";
import {
  moderateImageWithAi,
  moderateDocumentWithAi,
  ModerationAiResult,
} from "./geminiModeration";

/**
 * Descarga y analiza un archivo de S3 para verificar si infringe las normas comunitarias.
 *
 * @param urlOrKey URL pública de S3 o clave del objeto (uploads/...)
 * @param mediaType Tipo de contenido: 'IMAGE' para imágenes o 'PDF' para documentos
 */
export async function moderateS3Media(
  urlOrKey: string,
  mediaType: "IMAGE" | "PDF",
): Promise<ModerationAiResult> {
  if (!urlOrKey) {
    return { safe: true, confidence: 1.0, flaggedCategories: [], reason: null };
  }

  try {
    const match = urlOrKey.match(/(uploads\/[^?]+)/);
    const key = match ? match[1] : urlOrKey.startsWith("uploads/") ? urlOrKey : null;

    if (!key) {
      return {
        safe: true,
        confidence: 1.0,
        flaggedCategories: [],
        reason: null,
      };
    }

    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );

    if (!res.Body) {
      return {
        safe: true,
        confidence: 1.0,
        flaggedCategories: [],
        reason: null,
      };
    }

    const byteArray = await res.Body.transformToByteArray();
    const buffer = Buffer.from(byteArray);

    if (mediaType === "IMAGE") {
      const mime = res.ContentType || "image/jpeg";
      return await moderateImageWithAi(buffer, mime);
    } else {
      return await moderateDocumentWithAi(buffer);
    }
  } catch (err) {
    console.error(`Error al moderar archivo de S3 [${urlOrKey}]:`, err);
    // En caso de fallo de red o lectura de S3, retornamos seguro para no romper el flujo
    return { safe: true, confidence: 0.5, flaggedCategories: [], reason: null };
  }
}
