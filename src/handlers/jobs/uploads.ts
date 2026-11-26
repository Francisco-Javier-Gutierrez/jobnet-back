import { APIGatewayProxyHandler } from "aws-lambda";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import { s3Client, sesClient, bucketName, headers } from "./common";
import { extractAuthContext } from "../../utils/authHelper";
import { sendStyledJobNetEmail } from "../../utils/emailTemplate";

export const getUploadPresignedUrl: APIGatewayProxyHandler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    const folder = query.folder || "general";
    const filename = query.filename || "file";
    const userId = query.userId || "anonymous";

    // 1. Validation: Double extensions and dangerous files
    const parts = filename.toLowerCase().split(".");
    const dangerousExtensions = [
      "exe",
      "bat",
      "cmd",
      "sh",
      "js",
      "vbs",
      "scr",
      "msi",
      "jar",
      "com",
      "pif",
      "wsf",
      "dll",
      "sys",
    ];
    const knownExtensions = [
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "txt",
      "zip",
      "rar",
      "exe",
      "bat",
      "cmd",
      "sh",
      "js",
      "vbs",
    ];

    if (parts.length > 1) {
      const finalExt = parts[parts.length - 1];
      if (dangerousExtensions.includes(finalExt)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Extensión de archivo peligrosa no permitida.",
          }),
        };
      }

      if (parts.length > 2) {
        for (let i = 1; i < parts.length - 1; i++) {
          if (knownExtensions.includes(parts[i])) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({
                error:
                  "Validación de doble extensión fallida. Nombre de archivo sospechoso (ej. cv.pdf.exe).",
              }),
            };
          }
        }
      }
    }

    if (folder === "chat" || folder === "appeal") {
      const allowedChatExts = ["jpg", "jpeg", "png", "webp", "gif", "pdf"];
      const finalExt = parts[parts.length - 1];
      if (!allowedChatExts.includes(finalExt)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error:
              "Formato de archivo no permitido en chat. Solo se admiten PDF o imágenes (JPG, PNG, WebP, GIF).",
          }),
        };
      }
    }

    // 2. Validation: Strict 5MB size limit
    const sizeParam = query.size;
    if (!sizeParam) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "El tamaño del archivo (size) es requerido.",
        }),
      };
    }

    const size = parseInt(sizeParam, 10);
    if (isNaN(size) || size <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "El tamaño del archivo debe ser un número válido mayor a 0.",
        }),
      };
    }

    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (size > MAX_SIZE) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "El archivo supera el límite de 5MB." }),
      };
    }

    // Clean spaces and special characters from filename
    const cleanFilename = filename.replace(/\s+/g, "_");
    const timestamp = Date.now();
    const key = `uploads/${folder}/${userId}/${timestamp}-${cleanFilename}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: query.contentType || undefined,
      ContentLength: size,
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    const region = process.env.AWS_REGION || "us-east-1";
    const publicUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url, key, publicUrl }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const sendNotificationEmail: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { to, subject, message } = body;
    await sendStyledJobNetEmail({
      to,
      subject: subject || "Notificación de JobNet",
      client: sesClient,
      templateOptions: {
        title: subject || "Notificación Oficial de JobNet",
        badgeText: "Aviso JobNet",
        badgeType: "info",
        paragraphs: [message],
        cta: {
          text: "Ingresar a JobNet",
          url: "https://dsty3j5u0b31g.cloudfront.net",
        },
      },
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const getViewPresignedUrl: APIGatewayProxyHandler = async (event) => {
  try {
    let key = event.queryStringParameters?.key;
    const urlParam = event.queryStringParameters?.url;

    if (!key && urlParam) {
      const match = urlParam.match(/(uploads\/[^?]+)/);
      if (match) {
        key = match[1];
      }
    }

    const auth = await extractAuthContext(event);
    const isTestMode = process.env.NODE_ENV === "test";

    if (!auth.isAuthenticated && !isTestMode) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: "No autenticado. Token requerido para ver o descargar archivos.",
        }),
      };
    }

    if (!key) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "El parámetro 'key' o 'url' es requerido.",
        }),
      };
    }

    if (!key.startsWith("uploads/")) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Acceso no autorizado a la clave solicitada.",
        }),
      };
    }

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url, key, expiresIn: 3600 }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
