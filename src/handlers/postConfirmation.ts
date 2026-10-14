import {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const isOffline = process.env.IS_OFFLINE === "true";

const dynamoClient = isOffline
  ? new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    })
  : new DynamoDBClient({});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const handler: PostConfirmationTriggerHandler = async (
  event: PostConfirmationTriggerEvent,
) => {
  console.log(
    "PostConfirmation Trigger Event:",
    JSON.stringify(event, null, 2),
  );

  const userAttributes = event.request.userAttributes;
  const email = userAttributes.email;
  const sub = userAttributes.sub;

  const rawRole =
    event.request.clientMetadata?.tipoUsuario ||
    event.request.clientMetadata?.role ||
    userAttributes["custom:tipoUsuario"] ||
    userAttributes["custom:role"] ||
    "";

  let tipoUsuario: string;
  const normalizedRole = rawRole.toLowerCase().trim();
  if (normalizedRole === "admin") {
    tipoUsuario = "ADMIN";
  } else if (normalizedRole === "moderator") {
    tipoUsuario = "MODERATOR";
  } else if (
    normalizedRole === "company" ||
    normalizedRole === "empresa" ||
    normalizedRole === "organization" ||
    normalizedRole === "organizacion"
  ) {
    tipoUsuario = "ORGANIZACION";
  } else if (normalizedRole === "candidate" || normalizedRole === "candidato") {
    tipoUsuario = "CANDIDATO";
  } else {
    // Default fallback for blank, unassigned, none or missing role
    tipoUsuario = "PENDIENTE";
  }

  const nombre =
    event.request.clientMetadata?.nombre || userAttributes.name || "Sin Nombre";

  // 1. Preparar el objeto base a insertar en DynamoDB (Cognito Groups deprecados en favor de Scopes)
  const estadoCuenta = tipoUsuario === "PENDIENTE" ? "PENDIENTE_ROL" : "ACTIVO";
  const baseUser = {
    PK: `USER#${sub}`,
    SK: "PROFILE",
    GSI1PK: "PROFILE",
    GSI1SK: `ROLE#${tipoUsuario}#STATUS#${estadoCuenta}`,
    tipoUsuario,
    email,
    nombre,
    estadoCuenta,
    fechaCreacion: new Date().toISOString(),
  };

  // 2. Completar con atributos específicos según el rol
  const userItem = { ...baseUser };

  if (tipoUsuario === "PENDIENTE") {
    Object.assign(userItem, {
      fotoPerfil: "",
      biografia:
        "Usuario sin rol asignado. Pendiente de asignación de rol por un Administrador.",
    });
  } else if (tipoUsuario === "ADMIN" || tipoUsuario === "MODERATOR") {
    Object.assign(userItem, {
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      ubicacion: {},
    });
  } else if (tipoUsuario === "ORGANIZACION") {
    Object.assign(userItem, {
      taxId: userAttributes["custom:tax_id"] || "",
      telefono: userAttributes["phone_number"] || "",
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      ubicacion: {},
      organizacionVerificada: false,
    });
  } else {
    // CANDIDATO fallback
    Object.assign(userItem, {
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      documentosProfesionales: {},
      ubicacion: {},
      habilidades: [],
    });
  }

  // 3. RF-74: Restricción de Registro por Dominios Bloqueados
  if (tipoUsuario === "ORGANIZACION" && email && email.includes("@")) {
    const domain = email.split("@")[1].toLowerCase().trim();
    const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";
    try {
      const blockedRes = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `BLOCKED_DOMAIN#${domain}`,
            SK: "METADATA",
          },
        }),
      );
      if (blockedRes.Item) {
        throw new Error(
          `El dominio corporativo @${domain} ha sido suspendido definitivamente por prácticas fraudulentas o suplantación de identidad (RF-74).`,
        );
      }
    } catch (err: any) {
      if (err.message && err.message.includes("RF-74")) {
        console.error("Registro bloqueado por RF-74:", err.message);
        throw err;
      }
    }
  }

  // 4. Guardar en DynamoDB
  if (process.env.DYNAMODB_TABLE) {
    try {
      await docClient.send(
        new PutCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Item: userItem,
        }),
      );
      console.log("Usuario guardado exitosamente en DynamoDB");
    } catch (error) {
      console.error("Error guardando en DynamoDB:", error);
      throw error; // Propagar error hace que Cognito sepa que falló
    }
  }

  return event;
};
