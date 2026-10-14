import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { S3Client } from "@aws-sdk/client-s3";
import type { ContactLensAnalysisJson } from "./types.js";
import { fetchJsonObject } from "./s3.js";
import type { Logger } from "../../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AnalysisFetcher {
  fetch(bucket: string, key: string): Promise<ContactLensAnalysisJson>;
}

/** Real thing: fetches the object from S3. */
export class S3AnalysisFetcher implements AnalysisFetcher {
  constructor(private readonly s3: S3Client) {}

  async fetch(bucket: string, key: string): Promise<ContactLensAnalysisJson> {
    return fetchJsonObject<ContactLensAnalysisJson>(this.s3, bucket, key);
  }
}

/**
 * DEMO_MODE=true. Ignores the bucket entirely and serves a local fixture
 * from fixtures/, so the whole pipeline, EventBridge envelope parsing, auth,
 * normalization, signed outbound POST, can be exercised with zero AWS
 * account, zero credentials, zero real Contact Lens call. Never used unless
 * DEMO_MODE is explicitly set.
 */
export class DemoAnalysisFetcher implements AnalysisFetcher {
  constructor(private readonly logger: Logger) {}

  async fetch(_bucket: string, key: string): Promise<ContactLensAnalysisJson> {
    this.logger.warn("DEMO_MODE is on, serving a local fixture instead of calling S3", { key });
    const fixturePath = path.join(__dirname, "..", "..", "..", "fixtures", "amazon-connect", "sample-analysis.json");
    const text = await readFile(fixturePath, "utf-8");
    return JSON.parse(text) as ContactLensAnalysisJson;
  }
}
