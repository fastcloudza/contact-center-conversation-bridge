import { Router } from "express";
import { z } from "zod";
import type { S3Client } from "@aws-sdk/client-s3";
import { analysisPrefixes, type Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { requireApiKey } from "../../auth.js";
import { ingestConversation } from "../../ingest.js";
import { WebhookRejectedError } from "../../webhook.js";
import { createCtrResolver, type CtrResolver } from "./ctrResolver.js";
import { S3AnalysisFetcher, DemoAnalysisFetcher, type AnalysisFetcher } from "./analysisFetcher.js";
import { mapToSourceTranscript, mapToIdentityInfo, resolveContactId } from "./mapper.js";
import type { ContactLensAnalysisJson } from "./types.js";

const SOURCE_NAME = "amazon_connect_contact_lens";

/**
 * Shape of the event EventBridge hands to an API Destination target when
 * routing an S3 "Object Created" notification. EventBridge wraps the S3
 * event in its own envelope, this only validates the parts this adapter
 * reads.
 */
const eventBridgeS3Event = z.object({
  source: z.string().optional(),
  "detail-type": z.string().optional(),
  detail: z.object({
    bucket: z.object({ name: z.string() }),
    object: z.object({ key: z.string() }),
  }),
});

/** Marks a failure that no retry can fix: a missing file, no access to it,
 *  a file that is not valid JSON, a file that cannot be mapped. */
class PermanentError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PermanentError";
  }
}

/** S3 errors that will not go away on a retry. */
export function isPermanentS3Error(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.name === "AccessDenied") return true;
  const code = e?.$metadata?.httpStatusCode;
  return code === 403 || code === 404;
}

export function createAmazonConnectRouter(deps: { config: Config; s3: S3Client; logger: Logger }): Router {
  const { config, s3, logger } = deps;

  const analysisFetcher: AnalysisFetcher = config.AMAZON_CONNECT_DEMO_MODE
    ? new DemoAnalysisFetcher(logger)
    : new S3AnalysisFetcher(s3);
  const ctrResolver: CtrResolver = createCtrResolver(config, s3, logger);

  const router = Router();
  router.use(requireApiKey(config));

  router.post("/", async (req, res) => {
    const parsed = eventBridgeS3Event.safeParse(req.body);
    if (!parsed.success) {
      logger.warn("Ignoring request that doesn't look like an S3 Object Created event via EventBridge", {
        issues: parsed.error.issues,
      });
      res.status(200).json({ skipped: true, reason: "unrecognized_event_shape" });
      return;
    }

    const { bucket, object } = parsed.data.detail;

    const prefixes = analysisPrefixes(config.AMAZON_CONNECT_ANALYSIS_PATH_PREFIX);
    if (!prefixes.some((p) => object.key.startsWith(p)) || !object.key.endsWith(".json")) {
      logger.debug("Skipping object outside the configured analysis prefix", {
        bucket: bucket.name,
        key: object.key,
        prefixes,
      });
      res.status(200).json({ skipped: true, reason: "outside_analysis_prefix" });
      return;
    }

    // Answer right away. EventBridge only needs to know the request was
    // accepted, and a slow S3 read or a slow receiver must not cause it to time
    // out and deliver the same event again. The work happens after the reply.
    res.status(200).json({ accepted: true });

    try {
      let analysis: ContactLensAnalysisJson;
      try {
        analysis = await analysisFetcher.fetch(bucket.name, object.key);
      } catch (err) {
        throw isPermanentS3Error(err) ? new PermanentError(err) : err;
      }

      let normalizedInput;
      try {
        const contactId = resolveContactId(analysis, { s3Key: object.key });
        const ctr = await ctrResolver.resolve(contactId);
        normalizedInput = {
          transcript: mapToSourceTranscript(analysis, { s3Key: object.key }),
          identity: mapToIdentityInfo(ctr),
        };
      } catch (err) {
        // A file that cannot be mapped will not map on a second try either.
        throw new PermanentError(err);
      }

      const normalized = await ingestConversation(
        config,
        logger,
        normalizedInput.transcript,
        normalizedInput.identity,
        SOURCE_NAME,
        { analysisS3Bucket: bucket.name, analysisS3Key: object.key },
      );
      logger.info("Processed Contact Lens analysis object", {
        bucket: bucket.name,
        key: object.key,
        contactId: normalized.call_uuid,
      });
    } catch (err) {
      const cause = err instanceof PermanentError ? err.cause : err;
      const permanent = err instanceof PermanentError || err instanceof WebhookRejectedError;
      const fields = {
        bucket: bucket.name,
        key: object.key,
        error: cause instanceof Error ? cause.message : String(cause),
      };
      if (permanent) {
        logger.warn("Skipped Contact Lens analysis object, retrying would not help", { ...fields, skipped: true });
      } else {
        logger.error("Failed to process Contact Lens analysis object", fields);
      }
    }
  });

  return router;
}
