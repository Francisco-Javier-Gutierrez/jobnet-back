const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = "jobnet-jobs-prod";

async function fixUrls() {
  let lastEvaluatedKey = undefined;
  let updatedCount = 0;
  console.log("Starting scan to fix S3 URLs in DynamoDB...");

  do {
    const scanRes = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (scanRes.Items) {
      for (const item of scanRes.Items) {
        const itemStr = JSON.stringify(item);
        if (itemStr.includes("s3-website-us-east-1.amazonaws.com")) {
          // Replace http://jobnet-uploads-prod.s3-website-us-east-1.amazonaws.com
          // with https://jobnet-uploads-prod.s3.amazonaws.com

          let newItemStr = itemStr.replace(
            /http:\/\/([^.]+)\.s3-website-us-east-1\.amazonaws\.com/g,
            "https://$1.s3.amazonaws.com",
          );

          const newItem = JSON.parse(newItemStr);

          await docClient.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: newItem,
            }),
          );
          console.log(`Updated item PK: ${item.PK}, SK: ${item.SK}`);
          updatedCount++;
        }
      }
    }

    lastEvaluatedKey = scanRes.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Done! Successfully updated ${updatedCount} items.`);
}

fixUrls().catch(console.error);
