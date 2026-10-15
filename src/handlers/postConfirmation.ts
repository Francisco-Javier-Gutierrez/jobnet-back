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
import {
  isCorporateEmailDomain,
  isBlockedFraudDomain,
} from "../utils/domainVerifier";

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
  const solicitudRol =
    event.request.clientMetadata?.solicitudRol ||
    (normalizedRole.includes("mod") && normalizedRole !== "moderator"
      ? "MODERATOR"
      : normalizedRole.includes("admin") && normalizedRole !== "admin"
        ? "ADMIN"
        : "");

  const isAspirant =
    normalizedRole.includes("pending") ||
    normalizedRole.includes("aspirant") ||
    normalizedRole.includes("blank") ||
    normalizedRole === "unassigned" ||
    !!solicitudRol;

  const isGoogleFederated =
    event.userName?.toLowerCase().startsWith("google_") ||
    Boolean(userAttributes.identities && userAttributes.identities.includes("Google"));

  if (isGoogleFederated && (!normalizedRole || normalizedRole === "candidate" || normalizedRole === "candidato")) {
    tipoUsuario = "CANDIDATO";
  } else if (isAspirant) {
    tipoUsuario = "PENDIENTE";
  } else if (normalizedRole === "admin") {
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
    event.request.clientMetadata?.nombre ||
    userAttributes.name ||
    userAttributes.given_name ||
    (email && email.includes("@") ? email.split("@")[0] : "Sin Nombre");

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
    origenRegistro: isGoogleFederated ? "GOOGLE_OAUTH" : "DIRECTO",
    fechaCreacion: new Date().toISOString(),
  };

  // 2. Completar con atributos específicos según el rol
  const userItem = { ...baseUser };

  if (tipoUsuario === "PENDIENTE") {
    const rolEsperado =
      solicitudRol === "MODERATOR" || normalizedRole.includes("mod")
        ? "Moderador"
        : "Administrador";
    const detectedSolicitud =
      solicitudRol ||
      (normalizedRole.includes("mod") ? "MODERATOR" : "ADMIN");
    Object.assign(userItem, {
      fotoPerfil: "",
      solicitudRol: detectedSolicitud,
      biografia: `Aspirante a rol de ${rolEsperado}. Cuenta en estado inactivo neutral pendiente de autorización y asignación de rol en AWS Cognito por el titular de la cuenta.`,
    });
  } else if (tipoUsuario === "ADMIN" || tipoUsuario === "MODERATOR") {
    Object.assign(userItem, {
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      ubicacion: {},
    });
  } else if (tipoUsuario === "ORGANIZACION") {
    const domain =
      email && email.includes("@")
        ? email.split("@")[1].toLowerCase().trim()
        : "";
    const isAutoVerified = isCorporateEmailDomain(domain);

    const rfcVal =
      event.request.clientMetadata?.rfc ||
      event.request.clientMetadata?.taxId ||
      userAttributes["custom:tax_id"] ||
      "";
    const razonSocialVal =
      event.request.clientMetadata?.razonSocial ||
      event.request.clientMetadata?.nombre ||
      userAttributes.name ||
      "";
    const nombreComercialVal =
      event.request.clientMetadata?.nombreComercial ||
      userAttributes.name ||
      event.request.clientMetadata?.nombre ||
      "";
    const telefonoVal =
      event.request.clientMetadata?.telefono ||
      userAttributes["phone_number"] ||
      "";

    Object.assign(userItem, {
      taxId: rfcVal,
      rfc: rfcVal,
      razonSocial: razonSocialVal,
      nombreComercial: nombreComercialVal,
      telefono: telefonoVal,
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      ubicacion: {},
      organizacionVerificada: isAutoVerified,
      estatusVerificacion: isAutoVerified ? "VERIFICADA" : "PENDIENTE",
      metodoVerificacion: isAutoVerified
        ? "AUTOMATICO_DOMINIO_CORPORATIVO"
        : "MANUAL_PENDIENTE",
      dominioCorporativo: domain || "",
      fechaVerificacion: isAutoVerified ? new Date().toISOString() : null,
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

  // 3. RN-3 / RF-74: Restricción de Registro por Dominios Bloqueados
  if (tipoUsuario === "ORGANIZACION" && email && email.includes("@")) {
    const domain = email.split("@")[1].toLowerCase().trim();
    if (isBlockedFraudDomain(domain)) {
      throw new Error(
        `El dominio corporativo @${domain} ha sido suspendido definitivamente por prácticas fraudulentas o suplantación de identidad (RN-3 / RF-74).`,
      );
    }

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
      if (blockedRes?.Item) {
        throw new Error(
          `El dominio corporativo @${domain} ha sido suspendido definitivamente por prácticas fraudulentas o suplantación de identidad (RF-74).`,
        );
      }
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes("RF-74") || err.message.includes("RN-3"))
      ) {
        console.error("Registro bloqueado por RN-3/RF-74:", err.message);
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
