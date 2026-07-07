/* eslint-disable @typescript-eslint/no-explicit-any */
import { CognitoJwtVerifier } from "aws-jwt-verify";

// Extract USER_POOL_ID from environment
const userPoolId = process.env.COGNITO_USER_POOL_ID;

// For mock/local testing if the ID is missing
const isLocal = userPoolId === "us-east-1_local";

const verifier = isLocal
  ? null
  : CognitoJwtVerifier.create({
      userPoolId: userPoolId as string,
      tokenUse: "id", // Or "access" depending on what the client sends
      clientId: null, // Any client ID is fine
    });

export const handler = async (event: any) => {
  console.log("wsAuthorizer Event: ", JSON.stringify(event));

  // The token could come from query string or headers
  let token = (event as any).queryStringParameters?.token;
  if (!token && (event as any).headers?.Authorization) {
    token = (event as any).headers.Authorization.replace("Bearer ", "");
  }

  if (!token) {
    return generatePolicy("user", "Deny", (event as any).methodArn);
  }

  if (isLocal) {
    // Mock local validation
    return generatePolicy("mock-user-id", "Allow", (event as any).methodArn);
  }

  try {
    const payload = await verifier!.verify(token);
    return generatePolicy(payload.sub, "Allow", (event as any).methodArn);
  } catch (err) {
    console.error("Token verification failed: ", err);
    return generatePolicy("user", "Deny", (event as any).methodArn);
  }
};

const generatePolicy = (
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
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
  };
};
