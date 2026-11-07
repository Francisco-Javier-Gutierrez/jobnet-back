const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

async function clean() {
  const table = "jobnet-jobs-prod";
  let lastEvaluatedKey = undefined;

  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    lastEvaluatedKey = res.LastEvaluatedKey;

    for (const item of res.Items) {
      if (item.PK.startsWith("JOB#") && item.SK.startsWith("APP#")) {
        console.log("Deleting employer app view:", item.PK, item.SK);
        await docClient.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: item.PK, SK: item.SK },
          }),
        );
      } else if (item.PK.startsWith("USER#") && item.SK.startsWith("APP#")) {
        console.log("Deleting candidate app view:", item.PK, item.SK);
        await docClient.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: item.PK, SK: item.SK },
          }),
        );
      }
    }
  } while (lastEvaluatedKey);

  console.log("Done");
}

clean().catch(console.error);
