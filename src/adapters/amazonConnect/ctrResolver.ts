import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../../config.js";
import type { CtrRecord } from "./types.js";
import { fetchJsonObject } from "./s3.js";
import type { Logger } from "../../logger.js";

export interface CtrResolver {
  resolve(contactId: string): Promise<CtrRecord | null>;
}

/** Default. No CTR enrichment, customer.phoneNumber and queue come back null. */
export class NoopCtrResolver implements CtrResolver {
  async resolve(): Promise<CtrRecord | null> {
    return null;
  }
}

/**
 * Looks up a CTR record as a single JSON object at
 * `${CTR_S3_PREFIX}${contactId}.json`.
 *
 * IMPORTANT: this is NOT how raw Kinesis Data Firehose delivery of CTRs
 * looks by default, Firehose batches many contacts' records per file on a
 * time interval, it doesn't write one object per ContactId. This resolver
 * assumes you have a small consumer of your own (a Lambda on the Firehose
 * delivery stream, or a Kinesis consumer) that re-writes each CTR as its own
 * object at this path. If you don't have that yet, either build it, or
 * write a different CtrResolver against however your CTR data actually
 * lands (Athena over the batched files, a database, etc). This
 * implementation exists as a working example of the interface, not as a
 * claim about how Firehose behaves out of the box.
 */
export class S3CtrResolver implements CtrResolver {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  async resolve(contactId: string): Promise<CtrRecord | null> {
    const key = `${this.prefix}${contactId}.json`;
    try {
      return await fetchJsonObject<CtrRecord>(this.s3, this.bucket, key);
    } catch (err) {
      this.logger.warn("CTR lookup failed, continuing without customer/queue enrichment", {
        contactId,
        bucket: this.bucket,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export function createCtrResolver(config: Config, s3: S3Client, logger: Logger): CtrResolver {
  if (config.AMAZON_CONNECT_CTR_RESOLVER === "s3") {
    // CTR_S3_BUCKET presence already validated in loadConfig().
    return new S3CtrResolver(s3, config.AMAZON_CONNECT_CTR_S3_BUCKET as string, config.AMAZON_CONNECT_CTR_S3_PREFIX, logger);
  }
  return new NoopCtrResolver();
}
