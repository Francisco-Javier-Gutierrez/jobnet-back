const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const REGION = "us-east-1";
const TABLE_NAME = "jobnet-jobs-prod"; // Ajusta esto si tu tabla se llama distinto

// Setup client with profile
process.env.AWS_PROFILE = "terra-profile";
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function truncateTable() {
  console.log(`Starting database truncate on table: ${TABLE_NAME}...`);
  console.log(
    "Rule: Deleting everything EXCEPT (PK begins with 'USER#' AND SK == 'PROFILE')",
  );

  let lastEvaluatedKey = undefined;
  let itemsDeleted = 0;
  let itemsKept = 0;

  do {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (scanResult.Items) {
      for (const item of scanResult.Items) {
        const pk = item.PK || "";
        const sk = item.SK || "";

        // Condición para mantener los perfiles de usuario
        const isUserProfile = pk.startsWith("USER#") && sk === "PROFILE";

        if (isUserProfile) {
          itemsKept++;
          console.log(`Keeping User Profile: ${pk}`);
        } else {
          // Eliminar el registro
          await docClient.send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                PK: pk,
                SK: sk,
              },
            }),
          );
          itemsDeleted++;
          console.log(`Deleted record -> PK: ${pk} | SK: ${sk}`);
        }
      }
    }
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log("-----------------------------------------");
  console.log(`Truncate operation completed.`);
  console.log(`Items deleted: ${itemsDeleted}`);
  console.log(`User Profiles kept: ${itemsKept}`);
  console.log("-----------------------------------------");
}

truncateTable().catch(console.error);
