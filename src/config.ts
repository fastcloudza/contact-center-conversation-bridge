import { z } from "zod";

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

/**
 * Reads an on/off setting from the environment.
 *
 * Do NOT use z.coerce.boolean() for this: it applies JavaScript's Boolean(),
 * so every non-empty string, including "false", "0", "no" and "off", comes out
 * as true. That silently turned AMAZON_CONNECT_DEMO_MODE=false (the value in
 * .env.example) into demo mode ON.
 *
 * Accepted, case-insensitive and ignoring surrounding whitespace:
 *   on:  true, 1, yes, y, on
 *   off: false, 0, no, n, off
 * Unset or blank means "use the default". Anything else is an error, so a typo
 * fails at startup instead of silently picking a side.
 */
export function envBoolean(defaultValue: boolean) {
  return z.preprocess((raw, ctx) => {
    if (raw === undefined || raw === null) return defaultValue;
    if (typeof raw === "boolean") return raw;
    const value = String(raw).trim().toLowerCase();
    if (value === "") return defaultValue;
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be one of: true, false, 1, 0, yes, no, on, off (got "${String(raw)}")`,
    });
    return z.NEVER;
  }, z.boolean());
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  INBOUND_API_KEY_HEADER: z.string().min(1).default("x-api-key"),
  INBOUND_API_KEY: z.string().min(16, "INBOUND_API_KEY must be set to a long random value"),

  OUTBOUND_WEBHOOK_URL: z.string().url(),
  OUTBOUND_WEBHOOK_SECRET: z.string().min(16, "OUTBOUND_WEBHOOK_SECRET must be set to a long random value"),
  OUTBOUND_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Identifiers the receiving side uses for the business. All optional. They
  // are copied into every outgoing payload as waba_id, waba_phone and country_code.
  RECEIVER_BUSINESS_ID: z.string().optional(),
  RECEIVER_BUSINESS_PHONE: z.string().optional(),
  RECEIVER_COUNTRY_CODE: z.string().optional(),

  // Amazon Connect adapter
  AMAZON_CONNECT_ENABLED: envBoolean(true),
  AMAZON_CONNECT_DEMO_MODE: envBoolean(false),
  AMAZON_CONNECT_AWS_REGION: z.string().min(1).default("us-east-1"),
  AMAZON_CONNECT_AWS_ACCESS_KEY_ID: z.string().optional(),
  AMAZON_CONNECT_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AMAZON_CONNECT_ANALYSIS_PATH_PREFIX: z.string().min(1).default("Analysis/Voice/,Analysis/Chat/"),
  AMAZON_CONNECT_CTR_RESOLVER: z.enum(["none", "s3"]).default("none"),
  AMAZON_CONNECT_CTR_S3_BUCKET: z.string().optional(),
  AMAZON_CONNECT_CTR_S3_PREFIX: z.string().default("ContactTraceRecords/"),
});

/** The prefix setting may hold several prefixes separated by commas. */
export function analysisPrefixes(value: string): string[] {
  return value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

export type Config = z.infer<typeof schema> & {
  amazonConnectAwsCredentials: { accessKeyId: string; secretAccessKey: string } | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);

  if (parsed.AMAZON_CONNECT_CTR_RESOLVER === "s3" && !parsed.AMAZON_CONNECT_CTR_S3_BUCKET) {
    throw new Error("AMAZON_CONNECT_CTR_S3_BUCKET is required when AMAZON_CONNECT_CTR_RESOLVER=s3");
  }

  const amazonConnectAwsCredentials =
    parsed.AMAZON_CONNECT_AWS_ACCESS_KEY_ID && parsed.AMAZON_CONNECT_AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: parsed.AMAZON_CONNECT_AWS_ACCESS_KEY_ID,
          secretAccessKey: parsed.AMAZON_CONNECT_AWS_SECRET_ACCESS_KEY,
        }
      : undefined;

  return { ...parsed, amazonConnectAwsCredentials };
}
