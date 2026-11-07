import { PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";
import { docClient, tableName, getEndpoint, createOfflineNotification } from "./common";

export const sendMessage = async (event: any) => {
  const connectionId = event.requestContext?.connectionId;
  const senderId = event.requestContext?.authorizer?.principalId || "anonymous";
  console.log(`sendMessage route hit by connection: ${connectionId}`);

  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
    const {
      jobId,
      candidateId,
      appealId,
      appealCompanyId,
      text,
      attachmentUrl,
      attachmentType,
      attachmentName,
      attachmentKey,
      messageId: clientMessageId,
    } = body;

    // Handle Appeal Chat Routing if appealId is present
    if (appealId && appealCompanyId) {
      if (!text && !attachmentUrl) {
        return {
          statusCode: 400,
          body: "Missing text or attachment parameter for appeal message",
        };
      }

      // 🛑 Verificar si el canal de apelación está cerrado (Auditoría de solo lectura)
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
            body: "Forbidden: El canal de apelación ha sido cerrado y es de solo lectura.",
          };
        }
      } catch (err) {
        console.error("Error verificando estado de apelación:", err);
      }

      const timestamp = new Date().toISOString();
      const messageId = clientMessageId || randomUUID();

      // Idempotency check: skip if this messageId was already persisted
      if (clientMessageId) {
        const dupCheck = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            FilterExpression: "messageId = :mid",
            ExpressionAttributeValues: {
              ":pk": `APPEAL_CHAT#${appealId}`,
              ":skPrefix": "MSG#",
              ":mid": clientMessageId,
            },
            Limit: 1,
            ScanIndexForward: false,
          }),
        );
        if (dupCheck.Items && dupCheck.Items.length > 0) {
          console.log(`Duplicate appeal messageId=${clientMessageId} skipped.`);
          return {
            statusCode: 200,
            body: JSON.stringify({
              message: "Duplicate message skipped",
              duplicate: true,
              item: dupCheck.Items[0],
            }),
          };
        }
      }

      const messageItem: any = {
        PK: `APPEAL_CHAT#${appealId}`,
        SK: `MSG#${timestamp}#${messageId}`,
        messageId,
        appealId,
        companyId: appealCompanyId,
        senderId,
        text: text || "",
        createdAt: timestamp,
      };

      if (attachmentUrl) {
        messageItem.attachmentUrl = attachmentUrl;
        messageItem.attachmentType = attachmentType || "file";
        messageItem.attachmentName = attachmentName || "attachment";
        messageItem.attachmentKey = attachmentKey || "";
      }

      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: messageItem,
        }),
      );

      const targetKeys: string[] = [`USER#${appealCompanyId}`, "ROLE#MODERATOR"];

      try {
        const companyProfile = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `USER#${appealCompanyId}`, SK: "PROFILE" },
          }),
        );
        const ownerSub = companyProfile.Item?.sub || companyProfile.Item?.cognitoSub;
        if (ownerSub && ownerSub !== appealCompanyId && !targetKeys.includes(`USER#${ownerSub}`)) {
          targetKeys.push(`USER#${ownerSub}`);
        }
      } catch {
        // Non-critical
      }

      const apigwClient = new ApiGatewayManagementApiClient({
        endpoint: getEndpoint(event),
      });

      const recipientPromises: Promise<void>[] = [];
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
        for (const cItem of connRes.Items || []) {
          const cid = cItem.SK.replace("WS_CONNECTION#", "");
          if (cid === connectionId) continue;
          if (cItem.userId && cItem.userId === senderId) continue;
          recipientPromises.push(
            apigwClient
              .send(
                new PostToConnectionCommand({
                  ConnectionId: cid,
                  Data: Buffer.from(
                    JSON.stringify({
                      type: "APPEAL_MESSAGE",
                      messageId,
                      appealId,
                      appealCompanyId,
                      senderId,
                      text: text || "",
                      attachmentUrl: attachmentUrl || null,
                      attachmentType:
                        attachmentType ||
                        (attachmentUrl && /\.(jpg|jpeg|png|webp|gif|svg)($|\?)/i.test(attachmentUrl)
                          ? "image"
                          : "file"),
                      attachmentName: attachmentName || "attachment",
                      createdAt: timestamp,
                    }),
                  ),
                }),
              )
              .then(() => {})
              .catch(async (err) => {
                if (err.name === "GoneException" || err.statusCode === 410) {
                  await docClient.send(
                    new DeleteCommand({
                      TableName: tableName,
                      Key: { PK: pkKey, SK: `WS_CONNECTION#${cid}` },
                    }),
                  );
                }
              }),
          );
        }
      }
      await Promise.all(recipientPromises);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Appeal message sent",
          item: messageItem,
        }),
      };
    }

    // Standard Application Chat Routing
    if (!jobId || !candidateId || (!text && !attachmentUrl)) {
      return {
        statusCode: 400,
        body: "Missing jobId, candidateId, text or attachment parameters",
      };
    }

    // Fetch the job details to check ownership
    const jobResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `VACANCY#${jobId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!jobResult.Item) {
      return { statusCode: 404, body: "Vacancy not found" };
    }

    const job = jobResult.Item;
    const companyId = job.empresaUuid;

    // Validate that sender is either the candidate or the company
    if (senderId !== candidateId && senderId !== companyId) {
      return {
        statusCode: 403,
        body: "Not authorized to send messages in this conversation",
      };
    }

    // 🛑 Verificar si el canal de la postulación está cerrado
    try {
      const appCheck = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `JOB#${jobId}`, SK: `APP#${candidateId}` },
        }),
      );
      if (appCheck.Item && ["RECHAZADO", "CONTRATADO", "CERRADO"].includes(appCheck.Item.status)) {
        return {
          statusCode: 403,
          body: "Forbidden: La postulación ha sido cerrada y el chat es de solo lectura.",
        };
      }
    } catch (err) {
      console.error("Error verificando estado de postulación:", err);
    }

    const timestamp = new Date().toISOString();
    const messageId = clientMessageId || randomUUID();

    // Idempotency check: skip if this messageId was already persisted
    if (clientMessageId) {
      const dupCheck = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          FilterExpression: "messageId = :mid",
          ExpressionAttributeValues: {
            ":pk": `CHAT#${jobId}#${candidateId}`,
            ":skPrefix": "MSG#",
            ":mid": clientMessageId,
          },
          Limit: 1,
          ScanIndexForward: false,
        }),
      );
      if (dupCheck.Items && dupCheck.Items.length > 0) {
        console.log(`Duplicate chat messageId=${clientMessageId} skipped.`);
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Duplicate message skipped",
            duplicate: true,
            item: dupCheck.Items[0],
          }),
        };
      }
    }

    const messageItem: any = {
      PK: `CHAT#${jobId}#${candidateId}`,
      SK: `MSG#${timestamp}#${messageId}`,
      messageId,
      senderId,
      text: text || "",
      createdAt: timestamp,
    };

    if (attachmentUrl) {
      messageItem.attachmentUrl = attachmentUrl;
      messageItem.attachmentType = attachmentType || "file";
      messageItem.attachmentName = attachmentName || "attachment";
      messageItem.attachmentKey = attachmentKey || "";
    }

    // Save chat message
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: messageItem,
      }),
    );

    // Identify recipient
    const recipientId = senderId === candidateId ? companyId : candidateId;

    // Fetch recipient active WebSocket connections
    const connectionsResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `USER#${recipientId}`,
          ":skPrefix": "WS_CONNECTION#",
        },
      }),
    );

    const activeConnections = connectionsResult.Items || [];
    const apigwClient = new ApiGatewayManagementApiClient({
      endpoint: getEndpoint(event),
    });

    let deliveredSockets = 0;
    // Route messages to all active connection IDs of the recipient
    const sendPromises = activeConnections.map(async (connItem) => {
      const targetConnectionId = connItem.SK.replace("WS_CONNECTION#", "");
      try {
        await apigwClient.send(
          new PostToConnectionCommand({
            ConnectionId: targetConnectionId,
            Data: Buffer.from(
              JSON.stringify({
                action: "receiveMessage",
                messageId,
                jobId,
                candidateId,
                senderId,
                text: text || "",
                attachmentUrl,
                attachmentType,
                attachmentName,
                createdAt: timestamp,
              }),
            ),
          }),
        );
        deliveredSockets++;
      } catch (err: any) {
        // If connection is stale/gone, delete it from DynamoDB
        if (err.statusCode === 410) {
          console.log(`Stale connection detected: ${targetConnectionId}, cleaning up.`);
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: `USER#${recipientId}`,
                SK: `WS_CONNECTION#${targetConnectionId}`,
              },
            }),
          );
          await docClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: `WS_CONNECTION#${targetConnectionId}`,
                SK: "METADATA",
              },
            }),
          );
        } else {
          console.error(`Error sending message to ${targetConnectionId}:`, err);
        }
      }
    });

    await Promise.all(sendPromises);

    if (activeConnections.length === 0 || deliveredSockets === 0) {
      await createOfflineNotification({
        userId: recipientId,
        title: "Nuevo mensaje de chat",
        message: text || attachmentName || "Tienes un nuevo mensaje en tu conversación.",
        url: `/messages?jobId=${jobId}&candidateId=${candidateId}`,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: messageItem }),
    };
  } catch (error: any) {
    console.error("Error sending WebSocket message:", error);
    return { statusCode: 500, body: `Error: ${error.message}` };
  }
};
