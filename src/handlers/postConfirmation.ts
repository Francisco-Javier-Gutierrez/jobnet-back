import {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

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
const cognitoClient = new CognitoIdentityProviderClient({});

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
  const username = event.userName;

  const rawRole =
    event.request.clientMetadata?.tipoUsuario ||
    userAttributes["custom:tipoUsuario"] ||
    userAttributes["custom:role"] ||
    "CANDIDATO";

  let tipoUsuario = "CANDIDATO";
  const normalizedRole = rawRole.toLowerCase();
  if (normalizedRole === "admin") {
    tipoUsuario = "ADMIN";
  } else if (normalizedRole === "moderator") {
    tipoUsuario = "MODERATOR";
  } else if (normalizedRole === "company" || normalizedRole === "empresa") {
    tipoUsuario = "EMPRESA";
  } else if (normalizedRole === "candidate" || normalizedRole === "candidato") {
    tipoUsuario = "CANDIDATO";
  }

  const nombre =
    event.request.clientMetadata?.nombre || userAttributes.name || "Sin Nombre";

  // 1. Asignar el usuario al grupo de Cognito
  const userPoolId = event.userPoolId || process.env.COGNITO_USER_POOL_ID;
  if (userPoolId && userPoolId !== "us-east-1_local") {
    try {
      await cognitoClient.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: username,
          GroupName: tipoUsuario,
        }),
      );
      console.log(
        `Usuario asignado al grupo ${tipoUsuario} en UserPool ${userPoolId}`,
      );
    } catch (error: unknown) {
      // Ignoramos si el grupo no existe u ocurre otro error menor, pero lo logueamos
      console.error("Error asignando grupo en Cognito:", error);
    }
  }

  // 2. Preparar el objeto base a insertar en DynamoDB
  const baseUser = {
    PK: `USER#${sub}`,
    SK: "PROFILE",
    tipoUsuario,
    email,
    nombre,
    estadoCuenta: "ACTIVO",
    fechaCreacion: new Date().toISOString(),
  };

  // 3. Completar con atributos específicos según el rol
  const userItem = { ...baseUser };

  if (tipoUsuario === "ADMIN") {
    // Nada más que agregar
  } else if (tipoUsuario === "MODERATOR") {
    // Solo un ejemplo si tuviéramos que forzar un nombre
    userItem.nombre = nombre;
  } else if (tipoUsuario === "EMPRESA") {
    Object.assign(userItem, {
      taxId: userAttributes["custom:tax_id"] || "",
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      ubicacion: {},
      organizacionVerificada: false,
    });
  } else {
    Object.assign(userItem, {
      fotoPerfil: "",
      biografia: "",
      enlacesWeb: {},
      documentosProfesionales: {},
      ubicacion: {},
      habilidades: [],
    });
  }

  // 4. RF-74: Restricción de Registro por Dominios Bloqueados
  if (tipoUsuario === "EMPRESA" && email && email.includes("@")) {
    const domain = email.split("@")[1].toLowerCase().trim();
    const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-dev";
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

  // 5. Guardar en DynamoDB
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
