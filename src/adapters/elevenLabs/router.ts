import express, { Router, type NextFunction, type Request, type Response } from "express";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { forwardToWebhook, WebhookRejectedError } from "../../webhook.js";
import { mapToCallRequest } from "./mapper.js";
import type { ElevenLabsEvent } from "./types.js";

const SIGNATURE_HEADER = "elevenlabs-signature";
const TRANSCRIPTION = "post_call_transcription";
/** The SDK rejects a signature older than this. The cheap check below uses the same figure. */
const TOLERANCE_MS = 30 * 60 * 1000;

export type VerifyFn = (rawBody: string, header: string, secret: string) => Promise<unknown>;

/** The official SDK check. Only constructEvent is used, it makes no network call, so the key is a placeholder. */
function sdkVerify(): VerifyFn {
  const client = new ElevenLabsClient({ apiKey: "unused" });
  return (rawBody, header, secret) => client.webhooks.constructEvent(rawBody, header, secret);
}

/** Rejects a request with no usable signature header before the body is read, so an unsigned caller cannot make the route buffer a large body. */
function requireSignatureShape(req: Request, res: Response, next: NextFunction): void {
  const header = req.header(SIGNATURE_HEADER) ?? "";
  const parts = header.split(",");
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const hasHash = parts.some((p) => p.startsWith("v0="));
  const stamp = t !== undefined && t !== "" ? Number(t) * 1000 : NaN;
  if (!hasHash || !Number.isFinite(stamp) || stamp < Date.now() - TOLERANCE_MS) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  next();
}

function idOf(event: ElevenLabsEvent): string | null {
  const id = event.data?.conversation_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export function createElevenLabsRouter(deps: { config: Config; logger: Logger; verify?: VerifyFn }): Router {
  const { config, logger } = deps;
  const verify = deps.verify ?? sdkVerify();
  const secret = config.ELEVENLABS_WEBHOOK_SECRET ?? "";

  const router = Router();
  router.use(requireSignatureShape);
  // The raw bytes are needed for the signature. The limit is large because
  // audio deliveries carry the whole recording.
  router.use(express.raw({ type: () => true, limit: `${config.ELEVENLABS_MAX_BODY_MB}mb` }));

  router.post("/", async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";

    let event: ElevenLabsEvent;
    try {
      event = (await verify(rawBody, req.header(SIGNATURE_HEADER) ?? "", secret)) as ElevenLabsEvent;
    } catch (err) {
      logger.warn("ElevenLabs signature check failed", { reason: err instanceof Error ? err.message : "unknown" });
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const conversationId = idOf(event);
    const type = typeof event.type === "string" ? event.type : "unknown";

    if (type !== TRANSCRIPTION) {
      logger.info("Ignoring ElevenLabs event", { type, conversationId });
      res.status(200).json({ ignored: true, reason: "event_type" });
      return;
    }

    const data = event.data;
    if (!data || !conversationId || typeof data.agent_id !== "string" || !Array.isArray(data.transcript)) {
      logger.warn("Skipped ElevenLabs transcription without the fields needed", { conversationId });
      res.status(200).json({ skipped: true, reason: "unrecognized_event_shape" });
      return;
    }

    const agent = config.elevenLabsAgentMap[data.agent_id];
    if (!agent) {
      logger.warn("Skipped ElevenLabs conversation from an agent that is not in the agent map", {
        agentId: data.agent_id,
        conversationId,
      });
      res.status(200).json({ skipped: true, reason: "unknown_agent" });
      return;
    }

    const { payload } = mapToCallRequest(data, agent, { customerPhoneVariable: config.ELEVENLABS_CUSTOMER_PHONE_VARIABLE });
    if (payload.conversation.length === 0) {
      logger.warn("Skipped ElevenLabs conversation with no turns that have text", { conversationId });
      res.status(200).json({ skipped: true, reason: "no_turns" });
      return;
    }

    try {
      await forwardToWebhook(config, payload, logger, {
        maxAttempts: config.ELEVENLABS_FORWARD_ATTEMPTS,
        event: "conversation.call",
      });
      res.status(200).json({ forwarded: true });
    } catch (err) {
      if (err instanceof WebhookRejectedError) {
        // A retry cannot fix a rejection, so ElevenLabs gets a 200.
        logger.warn("Receiver rejected the ElevenLabs conversation, retrying would not help", {
          conversationId,
          status: err.status,
          reason: err.message.slice(0, 200),
          skipped: true,
        });
        res.status(200).json({ skipped: true, reason: "receiver_rejected" });
        return;
      }
      logger.error("Could not deliver the ElevenLabs conversation, asking ElevenLabs to retry", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: "delivery_failed" });
    }
  });

  // A body over the limit would otherwise surface as an HTML error page.
  router.use((err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") {
      logger.warn("ElevenLabs request body over the configured limit", { limitMb: config.ELEVENLABS_MAX_BODY_MB });
      res.status(413).json({ error: "body too large" });
      return;
    }
    next(err);
  });

  return router;
}
