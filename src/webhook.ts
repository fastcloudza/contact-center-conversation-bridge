import { createHmac } from "node:crypto";
import type { Config } from "./config.js";
import type { NormalizedConversation } from "./types.js";
import type { Logger } from "./logger.js";

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** The receiver answered 4xx. Sending the same payload again will not help. */
export class WebhookRejectedError extends Error {
  constructor(public readonly status: number, detail: string) {
    super(`Webhook rejected payload (${status}): ${detail}`);
    this.name = "WebhookRejectedError";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs the normalized conversation to OUTBOUND_WEBHOOK_URL. The body is
 * signed with an HMAC-SHA256 over the raw JSON string so the receiver can
 * verify it actually came from this bridge, not just from anyone who
 * discovered the URL. Retries a small, fixed number of times with backoff
 * on network errors or 5xx, does not retry on 4xx, that's a receiver-side
 * rejection this bridge can't fix by trying again.
 */
export async function forwardToWebhook(
  config: Config,
  payload: NormalizedConversation,
  logger: Logger,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = sign(body, config.OUTBOUND_WEBHOOK_SECRET);

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OUTBOUND_WEBHOOK_TIMEOUT_MS);

    try {
      const res = await fetch(config.OUTBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Signature": signature,
          "X-Bridge-Event": "conversation.normalized",
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        logger.info("Forwarded normalized conversation", {
          contactId: payload.call_uuid,
          attempt,
          status: res.status,
        });
        return;
      }

      if (res.status >= 400 && res.status < 500) {
        const text = await res.text().catch(() => "");
        throw new WebhookRejectedError(res.status, text.slice(0, 500));
      }

      lastError = new Error(`Webhook returned ${res.status}`);
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (err instanceof WebhookRejectedError) {
        throw err; // 4xx, don't retry
      }
    }

    if (attempt < maxAttempts) {
      const backoffMs = 500 * 2 ** (attempt - 1);
      logger.warn("Webhook delivery attempt failed, retrying", {
        contactId: payload.call_uuid,
        attempt,
        backoffMs,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Webhook delivery failed");
}
