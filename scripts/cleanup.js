const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const REGION = "us-east-1";
const TABLE_NAME = "jobnet-jobs-prod";
const BUCKET_NAME = "jobnet-uploads-prod";

// Initialize AWS Clients using the specific profile
process.env.AWS_PROFILE = "terra-profile";
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({ region: REGION });

const WRONG_URL = `http://${BUCKET_NAME}.s3-website-${REGION}.amazonaws.com`;
const CORRECT_URL = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com`;

async function main() {
  console.log(`Starting cleanup on Table: ${TABLE_NAME} and Bucket: ${BUCKET_NAME}...`);

  let lastEvaluatedKey = undefined;
  const allItems = [];
  let updatedCount = 0;

  // 1. Scan DynamoDB Table
  do {
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (scanResult.Items) {
      allItems.push(...scanResult.Items);
    }
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Scanned ${allItems.length} items from DynamoDB.`);

  // 2. Fix broken URLs and collect all used active S3 keys
  const activeS3Keys = new Set();
  
  for (const item of allItems) {
    let itemStr = JSON.stringify(item);
    let updated = false;

    // Fix incorrect URLs
    if (itemStr.includes(WRONG_URL)) {
      itemStr = itemStr.replaceAll(WRONG_URL, CORRECT_URL);
      updated = true;
    }

    // Extract all used S3 keys
    // URLs look like: https://jobnet-uploads-prod.s3.us-east-1.amazonaws.com/uploads/...
    const regex = new RegExp(`https://${BUCKET_NAME}\\.s3\\.${REGION}\\.amazonaws\\.com/([^"\\\\s]+)`, 'g');
    let match;
    while ((match = regex.exec(itemStr)) !== null) {
      activeS3Keys.add(match[1]);
    }

    if (updated) {
      const fixedItem = JSON.parse(itemStr);
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: fixedItem,
      }));
      updatedCount++;
      console.log(`Fixed URLs in DB Item PK: ${fixedItem.PK} | SK: ${fixedItem.SK}`);
    }
  }

  console.log(`Updated ${updatedCount} DB items.`);
  console.log(`Found ${activeS3Keys.size} active S3 object keys in the database.`);

  // 3. List all objects in S3
  let isTruncated = true;
  let continuationToken = undefined;
  let s3ObjectsCount = 0;
  let deletedCount = 0;

  while (isTruncated) {
    const listResponse = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    if (listResponse.Contents) {
      for (const s3Obj of listResponse.Contents) {
        s3ObjectsCount++;
        const key = s3Obj.Key;

        // Skip keys that aren't in the 'uploads/' directory if necessary, but generally we check all
        if (!activeS3Keys.has(key)) {
          console.log(`Deleting orphaned S3 object: ${key}`);
          await s3Client.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
          }));
          deletedCount++;
        }
      }
    }

    isTruncated = listResponse.IsTruncated;
    continuationToken = listResponse.NextContinuationToken;
  }

  console.log(`Scanned ${s3ObjectsCount} objects in S3.`);
  console.log(`Deleted ${deletedCount} orphaned objects from S3.`);
  console.log("Cleanup completed successfully.");
}

main().catch(console.error);
