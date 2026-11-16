import express from "express";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { createAmazonConnectRouter } from "./adapters/amazonConnect/router.js";
import { createElevenLabsRouter, type VerifyFn } from "./adapters/elevenLabs/router.js";

export function buildServer(deps: { config: Config; s3?: S3Client; logger: Logger; elevenLabsVerify?: VerifyFn }) {
  const { config, s3, logger } = deps;
  const app = express();

  // A source whose signature covers the raw body mounts before the JSON
  // parser below, so its bytes are never parsed or changed. Every other route
  // is unaffected.
  if (config.ELEVENLABS_ENABLED) {
    app.use("/webhook/elevenlabs", createElevenLabsRouter({ config, logger, verify: deps.elevenLabsVerify }));
  }

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      adapters: { amazonConnect: config.AMAZON_CONNECT_ENABLED, elevenLabs: config.ELEVENLABS_ENABLED },
    });
  });

  // Each push-triggered adapter mounts its own router at its own path, with
  // its own auth check. Adding a second push adapter (see
  // docs/adding-a-source.md) means one more line here, nothing about
  // Amazon Connect's router changes.
  if (config.AMAZON_CONNECT_ENABLED) {
    if (!s3) throw new Error("The Amazon Connect adapter needs an S3 client");
    app.use("/webhook/amazon-connect", createAmazonConnectRouter({ config, s3, logger }));
  }

  return app;
}
