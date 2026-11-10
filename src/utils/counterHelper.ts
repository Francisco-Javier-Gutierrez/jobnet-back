import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

export type CounterAttribute = "likesCount" | "bookmarksCount" | "commentsCount" | "sharesCount";

/**
 * Updates an atomic counter on an entity's METADATA item in DynamoDB.
 * Ensures the counter never drops below 0 when decrementing.
 */
export async function updateAtomicCounter(
  docClient: any,
  tableName: string,
  pk: string,
  attribute: CounterAttribute,
  increment: number,
): Promise<number | undefined> {
  if (increment === 0) return undefined;

  try {
    if (increment > 0) {
      const res = await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: pk, SK: "METADATA" },
          UpdateExpression: `ADD ${attribute} :inc`,
          ExpressionAttributeValues: { ":inc": increment },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return res.Attributes?.[attribute];
    } else {
      // Decrement without going below 0
      try {
        const res = await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk, SK: "METADATA" },
            UpdateExpression: `ADD ${attribute} :inc`,
            ConditionExpression: `attribute_exists(${attribute}) AND ${attribute} > :zero`,
            ExpressionAttributeValues: {
              ":inc": increment,
              ":zero": 0,
            },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        return res.Attributes?.[attribute];
      } catch {
        // If condition failed (attribute was <= 0 or missing), clamp safely to 0
        const clampRes = await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk, SK: "METADATA" },
            UpdateExpression: `SET ${attribute} = :zero`,
            ExpressionAttributeValues: { ":zero": 0 },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        return clampRes.Attributes?.[attribute] ?? 0;
      }
    }
  } catch (err) {
    console.warn(`[counterHelper] Failed to update atomic counter ${attribute} for ${pk}:`, err);
    return undefined;
  }
}
