import { Request, Response, NextFunction } from "express";
import { APIGatewayProxyHandler, APIGatewayProxyEvent } from "aws-lambda";

/**
 * Adapts a standard AWS Lambda APIGatewayProxyHandler into an Express route handler.
 * Preserves event shape, pathParameters, queryStringParameters, headers, body,
 * and requestContext (including JWT authorizer claims).
 */
export const adaptHandler = (handler: APIGatewayProxyHandler) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Prepare raw or stringified body
      let rawBody: string | null = null;
      if (req.body !== undefined && req.body !== null) {
        rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }

      // 2. Prepare normalized headers
      const normalizedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          normalizedHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      }

      // 3. Prepare query string parameters
      const queryParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) {
          queryParams[key] = Array.isArray(value) ? String(value[0]) : String(value);
        }
      }

      // 4. Construct APIGatewayProxyEvent
      const event: APIGatewayProxyEvent = {
        body: rawBody,
        headers: normalizedHeaders,
        multiValueHeaders: {},
        httpMethod: req.method,
        isBase64Encoded: false,
        path: req.path,
        pathParameters: Object.keys(req.params).length > 0 ? (req.params as any) : null,
        queryStringParameters: Object.keys(queryParams).length > 0 ? queryParams : null,
        multiValueQueryStringParameters: null,
        stageVariables: null,
        requestContext: {
          accountId: "123456789012",
          apiId: "jobnet-express-api",
          protocol: req.protocol,
          httpMethod: req.method,
          identity: {
            accessKey: null,
            accountId: null,
            apiKey: null,
            apiKeyId: null,
            caller: null,
            clientCert: null,
            cognitoAuthenticationProvider: null,
            cognitoAuthenticationType: null,
            cognitoIdentityId: null,
            cognitoIdentityPoolId: null,
            principalOrgId: null,
            sourceIp: req.ip || "127.0.0.1",
            user: null,
            userAgent: req.headers["user-agent"] || "",
            userArn: null,
          },
          path: req.path,
          stage: process.env.NODE_ENV === "production" ? "prod" : process.env.NODE_ENV || "prod",
          requestId:
            (req.headers["x-request-id"] as string) || Math.random().toString(36).substring(2, 15),
          requestTimeEpoch: Date.now(),
          resourceId: "proxy",
          resourcePath: req.route?.path || req.path,
          authorizer: (req as any).authorizer || undefined,
        },
        resource: req.route?.path || req.path,
      };

      // 5. Execute handler
      const result = await handler(event, {} as any, () => {});

      if (!result) {
        return res.status(500).json({ error: "No response from handler" });
      }

      // 6. Forward headers
      if (result.headers) {
        for (const [key, val] of Object.entries(result.headers)) {
          if (val !== undefined && key.toLowerCase() !== "transfer-encoding") {
            res.setHeader(key, val as any);
          }
        }
      }

      const statusCode = result.statusCode || 200;

      // 7. Parse and send body
      if (typeof result.body === "string") {
        try {
          const parsed = JSON.parse(result.body);
          return res.status(statusCode).json(parsed);
        } catch {
          return res.status(statusCode).send(result.body);
        }
      }

      return res.status(statusCode).send(result.body || "");
    } catch (err) {
      next(err);
    }
  };
};
