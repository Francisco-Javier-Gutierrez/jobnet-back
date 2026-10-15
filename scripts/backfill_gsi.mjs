import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

// Configurar el uso del perfil terra-profile
process.env.AWS_PROFILE = "terra-profile";

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

async function run() {
  console.log(
    `Starting backfill on table: ${TABLE_NAME} using profile: terra-profile`,
  );
  let lastEvaluatedKey = undefined;
  let itemsToUpdate = [];
  let updatedCount = 0;
  let scannedCount = 0;

  do {
    const params = {
      TableName: TABLE_NAME,
      FilterExpression: "SK IN (:profile, :catalog)",
      ExpressionAttributeValues: {
        ":profile": "PROFILE",
        ":catalog": "CATALOG",
      },
      ExclusiveStartKey: lastEvaluatedKey,
    };

    const response = await docClient.send(new ScanCommand(params));
    const items = response.Items || [];
    scannedCount += response.Count || 0;

    for (const item of items) {
      let needsUpdate = false;
      const updatedItem = { ...item };

      if (item.SK === "PROFILE") {
        const expectedGSI1PK = "PROFILE";
        const role = item.tipoUsuario || "UNKNOWN";
        const status = item.estadoCuenta || "ACTIVO";
        const expectedGSI1SK = `ROLE#${role}#STATUS#${status}`;

        if (item.GSI1PK !== expectedGSI1PK || item.GSI1SK !== expectedGSI1SK) {
          updatedItem.GSI1PK = expectedGSI1PK;
          updatedItem.GSI1SK = expectedGSI1SK;
          needsUpdate = true;
        }
      } else if (item.SK === "CATALOG") {
        const expectedGSI1PK = "CATALOG";
        const category = item.category || "UNKNOWN";
        const expectedGSI1SK = `CATEGORY#${category}`;

        if (item.GSI1PK !== expectedGSI1PK || item.GSI1SK !== expectedGSI1SK) {
          updatedItem.GSI1PK = expectedGSI1PK;
          updatedItem.GSI1SK = expectedGSI1SK;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        itemsToUpdate.push({
          PutRequest: {
            Item: updatedItem,
          },
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;

    // Procesar en lotes de 25 (Límite máximo de BatchWriteItem)
    while (itemsToUpdate.length >= 25) {
      const batch = itemsToUpdate.splice(0, 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: batch,
          },
        }),
      );
      updatedCount += batch.length;
      console.log(`Updated ${updatedCount} items so far...`);
    }
  } while (lastEvaluatedKey);

  // Procesar items restantes
  if (itemsToUpdate.length > 0) {
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: itemsToUpdate,
        },
      }),
    );
    updatedCount += itemsToUpdate.length;
  }

  console.log(
    `Finished! Total scanned PROFILE/CATALOG items: ${scannedCount}. Total updated items: ${updatedCount}`,
  );
}

run().catch((err) => {
  console.error("Error during backfill:", err);
});
