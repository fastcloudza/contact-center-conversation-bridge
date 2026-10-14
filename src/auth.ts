import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "./config.js";

/**
 * Verifies the static API key EventBridge's API Destination Connection is
 * configured to send. This is NOT a cryptographic signature of the request
 * body, EventBridge API Destinations authenticate via a Connection's stored
 * credential (API key, basic auth, or OAuth client credentials), not by
 * signing payloads. A static key checked over HTTPS is the correct model to
 * match that, not a gap in this tool.
 */
/** Compares two secrets in constant time. Both are hashed first so the
 *  buffers always have the same length, which timingSafeEqual requires. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function requireApiKey(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header(config.INBOUND_API_KEY_HEADER);
    if (!provided || !secretsMatch(provided, config.INBOUND_API_KEY)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
