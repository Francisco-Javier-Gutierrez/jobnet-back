const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.DYNAMODB_TABLE || "jobnet-jobs-prod";

function updateUrlsInObject(obj) {
  if (!obj || typeof obj !== "object") return { modified: false, value: obj };

  let modified = false;

  if (Array.isArray(obj)) {
    const newArr = obj.map((item) => {
      const res = updateUrlsInObject(item);
      if (res.modified) modified = true;
      return res.value;
    });
    return { modified, value: newArr };
  }

  const newObj = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      if (val.includes(".s3-website-")) {
        const updatedStr = val.replace(
          /http:\/\/([^.]+)\.s3-website-([^.]+)\.amazonaws\.com\//g,
          "https://$1.s3.$2.amazonaws.com/",
        );
        if (updatedStr !== val) {
          newObj[key] = updatedStr;
          modified = true;
        } else {
          newObj[key] = val;
        }
      } else {
        newObj[key] = val;
      }
    } else if (typeof val === "object" && val !== null) {
      const res = updateUrlsInObject(val);
      if (res.modified) modified = true;
      newObj[key] = res.value;
    } else {
      newObj[key] = val;
    }
  }

  return { modified, value: newObj };
}

async function runMigration() {
  console.log(`Starting S3 URL migration on table: ${tableName}`);
  let lastEvaluatedKey = undefined;
  let totalScanned = 0;
  let totalUpdated = 0;

  do {
    const scanRes = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    const items = scanRes.Items || [];
    totalScanned += items.length;

    for (const item of items) {
      const { modified, value: updatedItem } = updateUrlsInObject(item);
      if (modified) {
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: updatedItem,
          }),
        );
        totalUpdated++;
        console.log(`Updated Item: PK=${item.PK}, SK=${item.SK}`);
      }
    }

    lastEvaluatedKey = scanRes.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(
    `Migration Complete! Total Scanned: ${totalScanned}, Total Updated: ${totalUpdated}`,
  );
}

runMigration().catch((err) => {
  console.error("Migration failed:", err);
});
