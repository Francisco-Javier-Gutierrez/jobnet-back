import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifierInstance: any = null;

export const getVerifier = () => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const isLocal =
    userPoolId === "us-east-1_local" ||
    !userPoolId ||
    process.env.IS_OFFLINE === "true" ||
    process.env.NODE_ENV === "test";

  if (isLocal) {
    return null;
  }

  if (!verifierInstance) {
    verifierInstance = CognitoJwtVerifier.create({
      userPoolId: userPoolId as string,
      tokenUse: null,
      clientId: null,
    });
  }
  return verifierInstance;
};

export interface AuthContext {
  userId: string;
  email?: string;
  role: string;
  isAdmin: boolean;
  isModerator: boolean;
  isAuthenticated: boolean;
}

/**
 * Normalizes legacy, English, or placeholder role strings into canonical JobNet roles.
 * Returns "" when the input is empty or a generic placeholder ("USER", "BLANK").
 */
export const normalizeRole = (raw?: unknown): string => {
  const upper = (raw || "").toString().trim().toUpperCase();
  if (!upper || upper === "USER" || upper === "BLANK") return "";
  if (upper === "CANDIDATE") return "CANDIDATO";
  if (upper === "COMPANY" || upper === "EMPRESA") return "ORGANIZACION";
  if (upper === "MODERADOR") return "MODERATOR";
  return upper;
};

export const extractAuthContext = async (event: any): Promise<AuthContext> => {
  if (!event) {
    return {
      userId: "",
      role: "",
      isAdmin: false,
      isModerator: false,
      isAuthenticated: false,
    };
  }

  // 1. Check API Gateway HTTP API (JWT authorizer) or REST / Lambda authorizer
  const authorizer = event.requestContext?.authorizer;
  const jwtClaims = authorizer?.jwt?.claims || authorizer?.claims;
  const principalId = authorizer?.principalId || authorizer?.lambda?.principalId;

  if (jwtClaims || principalId) {
    const sub = jwtClaims?.sub || principalId || "";
    const email = jwtClaims?.email || "";
    const rawRole = normalizeRole(
      jwtClaims?.["custom:role"] || jwtClaims?.["custom:tipoUsuario"] || authorizer?.role,
    );

    const groups = Array.isArray(jwtClaims?.["cognito:groups"])
      ? jwtClaims["cognito:groups"]
      : typeof jwtClaims?.["cognito:groups"] === "string"
        ? [jwtClaims["cognito:groups"]]
        : [];
    const hasAdminGroup = groups.some((g: string) => g.toUpperCase() === "ADMIN");
    const hasModGroup =
      hasAdminGroup ||
      groups.some(
        (g: string) =>
          g.toUpperCase() === "MODERATOR" ||
          g.toUpperCase() === "MODERADOR" ||
          g.toUpperCase().includes("MOD"),
      );

    const isAdmin = rawRole === "ADMIN" || hasAdminGroup;
    const isMod = isAdmin || rawRole === "MODERATOR" || hasModGroup;

    return {
      userId: sub,
      email,
      role: rawRole || (isAdmin ? "ADMIN" : isMod ? "MODERATOR" : ""),
      isAdmin,
      isModerator: isMod,
      isAuthenticated: !!sub,
    };
  }

  // 2. Extract Bearer Token from Authorization Header
  const headers = event.headers || {};
  const authHeader = headers.Authorization || headers.authorization;
  if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const verifier = getVerifier();

    if (verifier) {
      try {
        const payload = await verifier.verify(token);
        const sub = payload.sub;
        const email = (payload.email as string) || "";
        const rawRole = normalizeRole(payload["custom:role"] || payload["custom:tipoUsuario"]);

        const scopes =
          typeof payload.scope === "string"
            ? payload.scope.split(" ")
            : Array.isArray(payload.scope)
              ? payload.scope
              : Array.isArray(payload.scp)
                ? payload.scp
                : [];

        const groups = Array.isArray(payload["cognito:groups"])
          ? payload["cognito:groups"]
          : typeof payload["cognito:groups"] === "string"
            ? [payload["cognito:groups"]]
            : [];
        const hasAdminGroup = groups.some((g: string) => g.toUpperCase() === "ADMIN");
        const hasModGroup =
          hasAdminGroup ||
          groups.some(
            (g: string) =>
              g.toUpperCase() === "MODERATOR" ||
              g.toUpperCase() === "MODERADOR" ||
              g.toUpperCase().includes("MOD"),
          );

        const hasAdminScope = scopes.some((s: string) => s.toLowerCase().includes("admin"));
        const hasModScope =
          hasAdminScope ||
          scopes.some(
            (s: string) => s.toLowerCase().includes("moderator") || s.toLowerCase().includes("mod"),
          );

        const isAdmin = rawRole === "ADMIN" || hasAdminScope || hasAdminGroup;
        const isMod = isAdmin || rawRole === "MODERATOR" || hasModScope || hasModGroup;

        return {
          userId: sub,
          email,
          role: rawRole || (isAdmin ? "ADMIN" : isMod ? "MODERATOR" : ""),
          isAdmin,
          isModerator: isMod,
          isAuthenticated: true,
        };
      } catch (err) {
        console.warn("Token verification failed in authHelper:", err);
      }
    }
  }

  // 3. Header-based role & identity fallback (Local, Test, or trusted frontend propagation)
  const headerUserId =
    headers["x-user-id"] || headers["X-User-Id"] || headers["x-userid"] || headers["X-UserId"];
  const headerUserRole = normalizeRole(
    headers["x-user-role"] ||
      headers["X-User-Role"] ||
      headers["x-user-type"] ||
      headers["X-User-Type"],
  );

  if (headerUserId || headerUserRole) {
    const isAdmin = headerUserRole === "ADMIN";
    const isMod = isAdmin || headerUserRole === "MODERATOR";
    return {
      userId: headerUserId || "authenticated-user",
      email: (headers["x-user-email"] || headers["X-User-Email"] || "user@jobnet.com").toString(),
      role: headerUserRole || (isAdmin ? "ADMIN" : isMod ? "MODERATOR" : ""),
      isAdmin,
      isModerator: isMod,
      isAuthenticated: true,
    };
  }

  return {
    userId: "",
    role: "",
    isAdmin: false,
    isModerator: false,
    isAuthenticated: false,
  };
};
