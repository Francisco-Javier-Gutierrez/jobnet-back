import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

export const AI_COOLDOWN_SECONDS = 24 * 60 * 60; // 24 horas = 86400 segundos

export interface AiCooldownItem {
  PK: string;
  SK: string;
  userId?: string;
  jobId?: string;
  empresaUuid?: string;
  action: string;
  createdAt: string;
  expiresAt: string;
  ttl: number;
}

export interface JobAiCooldownItem {
  PK: string;
  SK: string;
  jobId: string;
  userId?: string;
  empresaUuid?: string;
  action: string;
  createdAt: string;
  expiresAt: string;
  ttl: number;
}

export interface AiCooldownCheckResult {
  isBlocked: boolean;
  remainingSeconds: number;
  remainingMs: number;
  expiresAt?: string;
  item?: AiCooldownItem;
}

/**
 * Consulta en DynamoDB si existe un registro activo de enfriamiento (cooldown) para una vacante específica.
 * Si el registro existe y su TTL no ha expirado, no permite regenerar el ranking con IA antes de 24h.
 */
export async function checkJobAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  jobId: string,
): Promise<AiCooldownCheckResult> {
  if (!jobId) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const res = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `JOB#${jobId}`,
        SK: "AI_COOLDOWN",
      },
    }),
  );

  if (!res.Item) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const item = res.Item as AiCooldownItem;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = item.ttl;

  // Si el TTL en segundos ya pasó en tiempo unix (antes de que DynamoDB ejecute el barrido asíncrono)
  if (typeof ttl === "number" && ttl <= nowSeconds) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const remainingSeconds =
    typeof ttl === "number" ? Math.max(0, ttl - nowSeconds) : AI_COOLDOWN_SECONDS;

  return {
    isBlocked: true,
    remainingSeconds,
    remainingMs: remainingSeconds * 1000,
    expiresAt:
      item.expiresAt || new Date((ttl || nowSeconds + AI_COOLDOWN_SECONDS) * 1000).toISOString(),
    item,
  };
}

/**
 * Registra un registro de bloqueo de IA para la vacante con TTL en DynamoDB (24 horas).
 * DynamoDB lo eliminará automáticamente transcurrido el TTL.
 */
export async function setJobAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  jobId: string,
  userId?: string,
  empresaUuid?: string,
  action: string = "AI_CANDIDATE_RANKING",
  cooldownSeconds: number = AI_COOLDOWN_SECONDS,
): Promise<JobAiCooldownItem> {
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ttlSeconds = nowSeconds + cooldownSeconds;
  const expiresAt = new Date(ttlSeconds * 1000).toISOString();

  const item: JobAiCooldownItem = {
    PK: `JOB#${jobId}`,
    SK: "AI_COOLDOWN",
    jobId,
    ...(userId ? { userId } : {}),
    ...(empresaUuid ? { empresaUuid } : {}),
    action,
    createdAt: now.toISOString(),
    expiresAt,
    ttl: ttlSeconds,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );

  return item;
}

/**
 * Elimina manualmente el registro de cooldown de una vacante en DynamoDB (para testing o reset).
 */
export async function deleteJobAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  jobId: string,
): Promise<void> {
  if (!jobId) return;

  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: `JOB#${jobId}`,
        SK: "AI_COOLDOWN",
      },
    }),
  );
}

/**
 * Consulta en DynamoDB si existe un registro activo de enfriamiento (cooldown) por persona.
 * Si el registro existe y su TTL no ha expirado, no permite generar contenido con IA.
 */
export async function checkUserAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
): Promise<AiCooldownCheckResult> {
  if (!userId) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const res = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `USER#${userId}`,
        SK: "AI_COOLDOWN",
      },
    }),
  );

  if (!res.Item) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const item = res.Item as AiCooldownItem;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = item.ttl;

  // Si el TTL en segundos ya pasó en tiempo unix (antes de que DynamoDB ejecute el barrido asíncrono)
  if (typeof ttl === "number" && ttl <= nowSeconds) {
    return { isBlocked: false, remainingSeconds: 0, remainingMs: 0 };
  }

  const remainingSeconds =
    typeof ttl === "number" ? Math.max(0, ttl - nowSeconds) : AI_COOLDOWN_SECONDS;

  return {
    isBlocked: true,
    remainingSeconds,
    remainingMs: remainingSeconds * 1000,
    expiresAt:
      item.expiresAt || new Date((ttl || nowSeconds + AI_COOLDOWN_SECONDS) * 1000).toISOString(),
    item,
  };
}

/**
 * Registra un registro de bloqueo de IA para el usuario con TTL en DynamoDB.
 * DynamoDB lo eliminará automáticamente transcurridas las 24 horas.
 */
export async function setUserAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  action: string = "AI_CANDIDATE_RANKING",
  jobId?: string,
  cooldownSeconds: number = AI_COOLDOWN_SECONDS,
): Promise<AiCooldownItem> {
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ttlSeconds = nowSeconds + cooldownSeconds;
  const expiresAt = new Date(ttlSeconds * 1000).toISOString();

  const item: AiCooldownItem = {
    PK: `USER#${userId}`,
    SK: "AI_COOLDOWN",
    userId,
    action,
    ...(jobId ? { jobId } : {}),
    createdAt: now.toISOString(),
    expiresAt,
    ttl: ttlSeconds,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );

  return item;
}

/**
 * Elimina manualmente el registro de cooldown de un usuario en DynamoDB (para admins/testing).
 */
export async function deleteUserAiCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
): Promise<void> {
  if (!userId) return;

  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: `USER#${userId}`,
        SK: "AI_COOLDOWN",
      },
    }),
  );
}
