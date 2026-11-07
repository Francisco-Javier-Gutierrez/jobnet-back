import { DynamoDBClient, ScanCommand, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  region: "us-east-1",
});
const TABLE_NAME = "jobnet-jobs-prod";

async function run() {
  let lastEvaluatedKey = undefined;
  let itemsToDelete = [];
  let deletedCount = 0;

  do {
    const params = {
      TableName: TABLE_NAME,
      ProjectionExpression: "PK, SK",
      ExclusiveStartKey: lastEvaluatedKey,
    };
    const response = await client.send(new ScanCommand(params));

    const items = response.Items || [];
    for (const item of items) {
      const pk = item.PK.S;
      if (!pk.startsWith("USER#") && !pk.startsWith("CATALOG#")) {
        itemsToDelete.push({
          DeleteRequest: {
            Key: {
              PK: item.PK,
              SK: item.SK,
            },
          },
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;

    while (itemsToDelete.length >= 25) {
      const batch = itemsToDelete.splice(0, 25);
      await client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [TABLE_NAME]: batch,
          },
        }),
      );
      deletedCount += batch.length;
      console.log(`Deleted ${deletedCount} items...`);
    }
  } while (lastEvaluatedKey);

  if (itemsToDelete.length > 0) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE_NAME]: itemsToDelete,
        },
      }),
    );
    deletedCount += itemsToDelete.length;
    console.log(`Deleted ${deletedCount} items...`);
  }

  console.log(`Finished. Total deleted items: ${deletedCount}`);
}

run().catch(console.error);
