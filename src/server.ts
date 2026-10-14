import express from "express";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { createAmazonConnectRouter } from "./adapters/amazonConnect/router.js";

export function buildServer(deps: { config: Config; s3: S3Client; logger: Logger }) {
  const { config, s3, logger } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, adapters: { amazonConnect: config.AMAZON_CONNECT_ENABLED } });
  });

  // Each push-triggered adapter mounts its own router at its own path, with
  // its own auth check. Adding a second push adapter (see
  // docs/adding-a-source.md) means one more line here, nothing about
  // Amazon Connect's router changes.
  if (config.AMAZON_CONNECT_ENABLED) {
    app.use("/webhook/amazon-connect", createAmazonConnectRouter({ config, s3, logger }));
  }

  return app;
}
