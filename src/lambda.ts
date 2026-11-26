import serverlessExpress from "@codegenie/serverless-express";
import { app } from "./app";

// Wrap Express application into standard AWS Lambda Handler
export const handler = serverlessExpress({ app });
