import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

process.env.AWS_PROFILE = "terra-profile";

const cognitoClient = new CognitoIdentityProviderClient({
  region: "us-east-1",
});

const dynamoClient = new DynamoDBClient({
  region: "us-east-1",
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const USER_POOL_ID = "us-east-1_trquL61F2";

const users = [
  {
    role_name: "admin",
    tipo: "ADMIN",
    email: "chinopaco.05@gmail.com",
    password: "Francisco_1",
    nombre: "Admin Francisco",
  },
  {
    role_name: "moderator",
    tipo: "MODERATOR",
    email: "franciscojavierg.h.051130@gmail.com",
    password: "Paco_12345",
    nombre: "Moderador Paco",
  },
  {
    role_name: "candidate",
    tipo: "CANDIDATO",
    email: "alguienn340@gmail.com",
    password: "Paco_12345",
    nombre: "Candidato Prueba",
  },
  {
    role_name: "organization",
    tipo: "ORGANIZACION",
    email: "franchescojavini@gmail.com",
    password: "Francisco_12345",
    nombre: "Empresa Prueba",
  },
];

async function run() {
  for (const u of users) {
    console.log(`\nCreando/Actualizando usuario ${u.email} (${u.tipo})...`);

    let sub = "";

    try {
      // 1. Crear usuario en Cognito
      const res = await cognitoClient.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: u.email,
          UserAttributes: [
            { Name: "email", Value: u.email },
            { Name: "email_verified", Value: "true" },
            { Name: "name", Value: u.nombre },
          ],
          MessageAction: "SUPPRESS", // No enviar email
        }),
      );
      sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value || "";
      console.log(" - Usuario Cognito creado con sub:", sub);
    } catch (e: any) {
      if (e.name === "UsernameExistsException") {
        console.log(" - El usuario Cognito ya existe. Obteniendo sub...");
        const existingUser = await cognitoClient.send(
          new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: u.email,
          }),
        );
        sub =
          existingUser.UserAttributes?.find((a) => a.Name === "sub")?.Value ||
          "";
        console.log(" - Sub recuperado:", sub);
      } else {
        console.error(" - Error Cognito:", e);
        continue;
      }
    }

    try {
      // 2. Establecer contraseña
      await cognitoClient.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: u.email,
          Password: u.password,
          Permanent: true,
        }),
      );
      console.log(" - Contraseña actualizada.");
    } catch (e: any) {
      console.error(" - Error actualizando contraseña:", e);
    }

    // 4. Crear en DynamoDB Local
    try {
      const baseUser = {
        PK: `USER#${sub}`,
        SK: "PROFILE",
        tipoUsuario: u.tipo,
        email: u.email,
        nombre: u.nombre,
        estadoCuenta: "ACTIVA",
        bloqueada: false,
        fotoPerfil:
          "https://ui-avatars.com/api/?name=" +
          encodeURIComponent(u.nombre) +
          "&background=random",
        fechaCreacion: new Date().toISOString(),
      };

      await docClient.send(
        new PutCommand({
          TableName: "jobnet-jobs-prod",
          Item: baseUser,
        }),
      );
      console.log(" - Perfil creado en DynamoDB Local.");
    } catch (e) {
      console.error(" - Error DynamoDB:", e);
    }
  }
  console.log("\nProceso terminado.");
}

run();
