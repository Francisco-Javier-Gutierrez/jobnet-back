import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";
import {
  docClient,
  tableName,
  getEndpoint,
  corsHeaders,
  createOfflineNotification,
} from "./common";
import { extractAuthContext } from "../../utils/authHelper";

export const getAppealMessages: APIGatewayProxyHandler = async (event: any) => {
  const appealId = event.pathParameters?.id || event.pathParameters?.appealId;

  if (!appealId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Missing path parameter 'id'",
      }),
    };
  }

  const auth = await extractAuthContext(event);
  const isTestMode = process.env.NODE_ENV === "test";

  if (!auth.isAuthenticated && !isTestMode) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Unauthorized: Token requerido para consultar apelación",
      }),
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `APPEAL_CHAT#${appealId}`,
          ":skPrefix": "MSG#",
        },
      }),
    );

    const messages = (result.Items || [])
      .filter((m) => !m.isJoinMessage && (!m.text || !m.text.includes("La empresa se ha unido")))
      .map((m) => ({
        appealId: m.appealId || appealId,
        companyId: m.companyId,
        senderId: m.senderId,
        text: m.text,
        attachmentUrl: m.attachmentUrl || null,
        attachmentType: m.attachmentType || null,
        attachmentName: m.attachmentName || null,
        createdAt: m.createdAt,
      }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(messages),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export const sendAppealMessageHttp: APIGatewayProxyHandler = async (event: any) => {
  const appealId = event.pathParameters?.id || event.pathParameters?.appealId;
  if (!appealId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Missing parameter 'id'" }),
    };
  }

  try {
    const auth = await extractAuthContext(event);
    const isTestMode = process.env.NODE_ENV === "test";

    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
    const { text, attachmentUrl, companyId } = body;

    if (!auth.isAuthenticated && !isTestMode && !body.senderId) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized: Token requerido" }),
      };
    }

    if (!companyId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing parameter 'companyId' in body",
        }),
      };
    }

    const senderId =
      auth.userId ||
      body.senderId ||
      event.requestContext?.authorizer?.principalId ||
      event.requestContext?.authorizer?.lambda?.principalId ||
      "MODERATOR";

    const isCompany = senderId === companyId;
    if (!isCompany && !auth.isModerator && !isTestMode) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Forbidden: No autorizado para enviar mensajes en este canal de apelación",
        }),
      };
    }

    // Verificar si el canal de apelación está cerrado (en producción)
    if (!isTestMode) {
      try {
        let isAppealClosed = false;
        const incidentCheck = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `INCIDENT#${appealId}`, SK: "METADATA" },
          }),
        );
        if (
          incidentCheck.Item &&
          ["RESUELTO", "RECHAZADO", "CERRADO", "APROBADO"].includes(incidentCheck.Item.estado)
        ) {
          isAppealClosed = true;
        } else {
          const verifyCheck = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: `VERIFICATION_REQUEST#${appealId}`, SK: "METADATA" },
            }),
          );
          if (
            verifyCheck.Item &&
            ["APROBADO", "RECHAZADO", "RESUELTO", "CERRADO"].includes(verifyCheck.Item.estado)
          ) {
            isAppealClosed = true;
          }
        }

        if (isAppealClosed) {
          return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({
              error: "Forbidden: El canal de apelación ha sido cerrado y es de solo lectura.",
            }),
          };
        }
      } catch (err) {
        console.error("Error verificando estado de apelación:", err);
      }
    }

    if (!text && !attachmentUrl) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing text or attachment" }),
      };
    }

    const timestamp = new Date().toISOString();
    const messageId = body.messageId || randomUUID();

    if (body.messageId) {
      const dupCheck = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          FilterExpression: "messageId = :mid",
          ExpressionAttributeValues: {
            ":pk": `APPEAL_CHAT#${appealId}`,
            ":skPrefix": "MSG#",
            ":mid": body.messageId,
          },
          Limit: 1,
          ScanIndexForward: false,
        }),
      );
      if (dupCheck.Items && dupCheck.Items.length > 0) {
        console.log(`Duplicate HTTP appeal messageId=${body.messageId} skipped.`);
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            success: true,
            duplicate: true,
            message: dupCheck.Items[0],
          }),
        };
      }
    }

    const messageItem: any = {
      PK: `APPEAL_CHAT#${appealId}`,
      SK: `MSG#${timestamp}#${messageId}`,
      messageId,
      appealId,
      companyId,
      senderId,
      text: text || "",
      createdAt: timestamp,
    };

    if (attachmentUrl) {
      messageItem.attachmentUrl = attachmentUrl;
    }

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: messageItem,
      }),
    );

    const targetKeys: string[] = [`USER#${companyId}`, "ROLE#MODERATOR"];

    try {
      const companyProfile = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `USER#${companyId}`, SK: "PROFILE" },
        }),
      );
      const ownerSub = companyProfile.Item?.sub || companyProfile.Item?.cognitoSub;
      if (ownerSub && ownerSub !== companyId && !targetKeys.includes(`USER#${ownerSub}`)) {
        targetKeys.push(`USER#${ownerSub}`);
      }
    } catch {
      // Non-critical
    }
    const apigwClient = new ApiGatewayManagementApiClient({
      endpoint: getEndpoint(event),
    });

    let delivered = 0;
    let companyHasSockets = false;

    for (const pkKey of targetKeys) {
      const connRes = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": pkKey,
            ":skPrefix": "WS_CONNECTION#",
          },
        }),
      );

      const activeConnections = connRes.Items || [];
      if (pkKey === `USER#${companyId}` && activeConnections.length > 0) {
        companyHasSockets = true;
      }

      for (const cItem of activeConnections) {
        const cid = cItem.SK.replace("WS_CONNECTION#", "");
        if (cItem.userId && cItem.userId === senderId) continue;
        try {
          await apigwClient.send(
            new PostToConnectionCommand({
              ConnectionId: cid,
              Data: Buffer.from(
                JSON.stringify({
                  type: "APPEAL_MESSAGE",
                  messageId,
                  appealId,
                  appealCompanyId: companyId,
                  senderId,
                  text: text || "",
                  attachmentUrl: attachmentUrl || null,
                  attachmentType:
                    body.attachmentType ||
                    (attachmentUrl && /\.(jpg|jpeg|png|webp|gif|svg)($|\?)/i.test(attachmentUrl)
                      ? "image"
                      : "file"),
                  attachmentName: body.attachmentName || "attachment",
                  createdAt: timestamp,
                }),
              ),
            }),
          );
          delivered++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.name === "GoneException") {
            await docClient.send(
              new DeleteCommand({
                TableName: tableName,
                Key: { PK: pkKey, SK: `WS_CONNECTION#${cid}` },
              }),
            );
          }
        }
      }
    }

    if (!companyHasSockets || delivered === 0) {
      await createOfflineNotification({
        userId: companyId,
        title: "Mensaje de Moderación (Apelación)",
        message: text || "Un moderador ha respondido a tu apelación.",
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true, message: messageItem }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
