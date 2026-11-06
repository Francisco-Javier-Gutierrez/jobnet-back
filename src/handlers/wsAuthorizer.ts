import { CognitoJwtVerifier } from "aws-jwt-verify";

export const getVerifier = () => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const isLocal =
    userPoolId === "us-east-1_local" ||
    !userPoolId ||
    process.env.IS_OFFLINE === "true";

  if (isLocal) {
    return null;
  }

  return CognitoJwtVerifier.create({
    userPoolId: userPoolId as string,
    tokenUse: null, // Allow both 'access' (which carries OAuth scopes) and 'id' tokens
    clientId: null, // Any client ID is accepted
  });
};

export const handler = async (event: any) => {
  console.log("wsAuthorizer Event: ", JSON.stringify(event));

  // The token could come from query string or Authorization header
  let token = (event as any).queryStringParameters?.token;
  if (!token && (event as any).headers?.Authorization) {
    token = (event as any).headers.Authorization.replace(/^Bearer\s+/i, "");
  }

  if (!token) {
    return generatePolicy("user", "Deny", (event as any).methodArn);
  }

  const verifier = getVerifier();

  if (!verifier) {
    // Mock local validation
    const customRole = (
      (event as any).queryStringParameters?.role ||
      (event as any).headers?.["x-user-role"] ||
      ""
    )
      .toString()
      .toUpperCase();

    const isMod = customRole === "ADMIN" || customRole === "MODERATOR";
    const role = isMod ? "MODERATOR" : "USER";

    return generatePolicy("mock-user-id", "Allow", (event as any).methodArn, {
      role,
      sub: "mock-user-id",
      email: "mock@example.com",
      scopes: "jobnet/candidate jobnet/organization",
    });
  }

  try {
    const payload = await verifier.verify(token);

    // Scopes from OAuth 2.0 Access Token (represented as space-delimited string or array in 'scope' / 'scp')
    const rawScope = ((payload as any).scope || (payload as any).scp || "") as
      string | string[];
    const scopes: string[] = Array.isArray(rawScope)
      ? rawScope
      : typeof rawScope === "string"
        ? rawScope.split(" ").filter(Boolean)
        : [];

    const customRole = (
      payload["custom:role"] ||
      payload["custom:tipoUsuario"] ||
      ""
    )
      .toString()
      .toUpperCase();

    // Check scopes (e.g. 'jobnet/admin', 'jobnet/moderator', 'admin', 'moderator')
    const hasAdminScope = scopes.some((s) => s.toLowerCase().includes("admin"));
    const hasModScope = scopes.some(
      (s) =>
        s.toLowerCase().includes("moderator") ||
        s.toLowerCase().includes("mod"),
    );

    const isMod =
      customRole === "ADMIN" ||
      customRole === "MODERATOR" ||
      hasAdminScope ||
      hasModScope;

    const role = isMod ? "MODERATOR" : "USER";

    return generatePolicy(payload.sub, "Allow", (event as any).methodArn, {
      role,
      sub: payload.sub,
      email: (payload.email as string) || "",
      scopes: scopes.join(" "),
    });
  } catch (err) {
    console.error("Token verification failed: ", err);
    return generatePolicy("user", "Deny", (event as any).methodArn);
  }
};

const generatePolicy = (
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
  context?: Record<string, any>,
) => {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context || {},
  };
};
