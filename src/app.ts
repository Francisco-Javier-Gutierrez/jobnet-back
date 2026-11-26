import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import router from "./routes";

export const app = express();

// Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Standard CORS Whitelist
const allowedOrigins = [
  "https://dsty3j5u0b31g.cloudfront.net",
  "https://jobnet.franciscojgh.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith(".cloudfront.net") ||
        origin.endsWith(".franciscojgh.com")
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive fallback for API Gateway
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "content-type",
      "Authorization",
      "authorization",
      "X-Amz-Date",
      "x-amz-date",
      "X-Api-Key",
      "x-api-key",
      "X-Amz-Security-Token",
      "x-amz-security-token",
      "X-Amz-User-Agent",
      "x-amz-user-agent",
      "X-User-Id",
      "x-user-id",
      "X-User-Role",
      "x-user-role",
      "X-User-Email",
      "x-user-email",
      "X-User-Type",
      "x-user-type",
      "X-User-Name",
      "x-user-name",
    ],
    maxAge: 3600,
  }),
);

// Body Parsers
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Root Health Endpoints
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    environment: process.env.NODE_ENV || "prod",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    name: "JobNet Core API",
    status: "online",
    version: "2.0.0",
    architecture: "Express + AWS Lambda Serverless",
  });
});

// Mount All Application Routes
app.use(router);

// 404 Route Not Found Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: `Ruta no encontrada: [${req.method}] ${req.originalUrl}`,
    path: req.originalUrl,
  });
});

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.statusCode || err.status || 500;
  console.error("[Express Error Handler]:", err);
  res.status(statusCode).json({
    error: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  });
});

export default app;
