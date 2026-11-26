import { APIGatewayProxyHandler } from "aws-lambda";
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, tableName, headers } from "./common";

export function getLevenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  let i: number;
  let j: number;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return tmp[a.length][b.length];
}

export const getSuggestedSkills: APIGatewayProxyHandler = async (event) => {
  try {
    const categoryFilter = event.queryStringParameters?.category;

    // 1. Scan all pending suggestions
    const suggestionsResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "SK = :sk AND (begins_with(PK, :skillPrefix) OR begins_with(PK, :sectorPrefix))",
        ExpressionAttributeValues: {
          ":sk": "METADATA",
          ":skillPrefix": "SUGGESTION#SKILL#",
          ":sectorPrefix": "SUGGESTION#SECTOR#",
        },
      }),
    );

    // 2. Scan all master catalog items to pre-calculate similarity matches
    const catalogResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :gsiPk",
        ExpressionAttributeValues: {
          ":gsiPk": "CATALOG",
        },
      }),
    );
    const catalogItems = catalogResult.Items || [];

    let suggestions = (suggestionsResult.Items || []).map((item: any) => {
      const isSector = item.PK.startsWith("SUGGESTION#SECTOR#") || item.category === "Sector";
      const itemCategory: "Habilidad" | "Sector" = isSector ? "Sector" : "Habilidad";
      const id = item.PK.replace("SUGGESTION#SKILL#", "").replace("SUGGESTION#SECTOR#", "");
      const name = item.name || "";

      // Find similarity matches in the same category
      const sameCatCatalog = catalogItems.filter((cat: any) => cat.category === itemCategory);
      const duplicateMatch = sameCatCatalog.find((cat: any) => {
        if (cat.name.toLowerCase() === name.toLowerCase()) return true;
        const dist = getLevenshteinDistance(cat.name, name);
        return dist <= 2;
      });

      return {
        id,
        name,
        category: itemCategory,
        createdAt: item.fechaCreacion || item.createdAt || "",
        hasDuplicate: !!duplicateMatch,
        existingName: duplicateMatch ? duplicateMatch.name : null,
      };
    });

    if (categoryFilter) {
      suggestions = suggestions.filter(
        (s) => s.category.toLowerCase() === categoryFilter.toLowerCase(),
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(suggestions),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const createSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { name, category } = body;

    if (!name) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'name'" }),
      };
    }

    const isSector = category === "Sector" || (event.path && event.path.includes("/sectors/"));
    const cat = isSector ? "Sector" : "Habilidad";
    const pkPrefix = isSector ? "SUGGESTION#SECTOR#" : "SUGGESTION#SKILL#";

    const uuid = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date().toISOString();

    const suggestionItem = {
      PK: `${pkPrefix}${uuid}`,
      SK: "METADATA",
      name: name.trim(),
      category: cat,
      fechaCreacion: createdAt,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: suggestionItem,
      }),
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        id: uuid,
        ...suggestionItem,
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};

export const resolveSkillSuggestion: APIGatewayProxyHandler = async (event) => {
  try {
    const suggestionId = event.pathParameters?.id;
    if (!suggestionId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing path parameter 'id'" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { approve, unifyWith, unifyMode, addAnyway } = body;

    if (approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing body parameter 'approve'" }),
      };
    }

    // Fetch existing suggestion (try skill first, then sector)
    let existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `SUGGESTION#SKILL#${suggestionId}`,
          SK: "METADATA",
        },
      }),
    );

    if (!existing.Item) {
      existing = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `SUGGESTION#SECTOR#${suggestionId}`,
            SK: "METADATA",
          },
        }),
      );
    }

    if (!existing.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Suggestion not found" }),
      };
    }

    const suggestion = existing.Item;
    const itemName = suggestion.name;
    const itemCategory: "Habilidad" | "Sector" =
      suggestion.category || (suggestion.PK.includes("#SECTOR#") ? "Sector" : "Habilidad");

    if (approve) {
      // Unification mode: REPLACE_EXISTING (replace existing master catalog name with suggested name)
      if (unifyMode === "REPLACE_EXISTING" && unifyWith) {
        // Find existing catalog item with unifyWith name
        const findCatalog = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :gsiPk AND GSI1SK = :gsiSk",
            FilterExpression: "valName = :v",
            ExpressionAttributeValues: {
              ":gsiPk": "CATALOG",
              ":gsiSk": `CATEGORY#${itemCategory}`,
              ":v": unifyWith.toLowerCase(),
            },
          }),
        );

        if (findCatalog.Items && findCatalog.Items.length > 0) {
          const targetCatalogItem = findCatalog.Items[0];
          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: targetCatalogItem.PK, SK: "CATALOG" },
              UpdateExpression: "SET #n = :newName, valName = :valName, updatedAt = :u",
              ExpressionAttributeNames: { "#n": "name" },
              ExpressionAttributeValues: {
                ":newName": itemName,
                ":valName": itemName.toLowerCase(),
                ":u": new Date().toISOString(),
              },
            }),
          );
        }
      } else if (unifyMode === "KEEP_EXISTING") {
        // Simply keep existing catalog item without adding new
      } else if (addAnyway || !unifyWith) {
        // Add as a brand new independent master catalog item
        const uuid = Math.random().toString(36).substring(2, 15);
        const finalName = unifyWith || itemName;

        const exactCheck = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :gsiPk AND GSI1SK = :gsiSk",
            FilterExpression: "valName = :valName",
            ExpressionAttributeValues: {
              ":gsiPk": "CATALOG",
              ":gsiSk": `CATEGORY#${itemCategory}`,
              ":valName": finalName.toLowerCase(),
            },
          }),
        );

        if (exactCheck.Items && exactCheck.Items.length > 0 && !addAnyway) {
          const match = exactCheck.Items[0];
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              duplicate: true,
              existingName: match.name,
              suggestionName: finalName,
              category: itemCategory,
              message: `La sugerencia '${finalName}' ya existe o es similar a '${match.name}' en el catálogo oficial.`,
            }),
          };
        }

        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `CATALOG#${uuid}`,
              SK: "CATALOG",
              GSI1PK: "CATALOG",
              GSI1SK: `CATEGORY#${itemCategory}`,
              name: finalName,
              valName: finalName.toLowerCase(),
              category: itemCategory,
              createdAt: new Date().toISOString(),
            },
          }),
        );
      }
    }

    // Delete suggestion from DynamoDB
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: suggestion.PK,
          SK: "METADATA",
        },
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        action: approve ? "APPROVED" : "REJECTED",
        unifyMode: unifyMode || null,
        category: itemCategory,
      }),
    };
  } catch (error: unknown) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (error as Error).message }),
    };
  }
};
