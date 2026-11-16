import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/** A blank setting counts as unset, so a copied .env.example keeps its defaults. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** One ElevenLabs agent and the business identifiers sent with its conversations. */
export const agentMapEntrySchema = z.object({
  wabaId: z.string().min(1),
  wabaPhone: z.string().min(1),
  companyId: z.string().optional(),
  agentExtension: z.string().optional(),
});
export const agentMapSchema = z.record(z.string().min(1), agentMapEntrySchema);
export type AgentMap = z.infer<typeof agentMapSchema>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads the agent map from inline JSON or from a file kept outside the repo. */
export function loadAgentMap(inline: string | undefined, file: string | undefined): AgentMap {
  if (inline && file) {
    throw new Error("Set only one of ELEVENLABS_AGENT_MAP and ELEVENLABS_AGENT_MAP_FILE");
  }
  let text = inline;
  if (file) {
    if (!isAbsolute(file)) throw new Error("ELEVENLABS_AGENT_MAP_FILE must be an absolute path");
    const rel = relative(repoRoot, resolve(file));
    const outside = rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
    if (!outside) {
      throw new Error("ELEVENLABS_AGENT_MAP_FILE must point outside the repository");
    }
    text = readFileSync(file, "utf-8");
  }
  if (!text) throw new Error("ELEVENLABS_AGENT_MAP or ELEVENLABS_AGENT_MAP_FILE is required when ELEVENLABS_ENABLED is on");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The ElevenLabs agent map is not valid JSON");
  }
  const parsed = agentMapSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("The ElevenLabs agent map is not valid: " + parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; "));
  }
  return parsed.data;
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  INBOUND_API_KEY_HEADER: z.string().min(1).default("x-api-key"),
  // Required only when a source that uses it is on (see loadConfig).
  INBOUND_API_KEY: z.preprocess(blankToUndefined, z.string().min(16, "INBOUND_API_KEY must be set to a long random value").optional()),

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

  // ElevenLabs adapter
  ELEVENLABS_ENABLED: envBoolean(false),
  ELEVENLABS_WEBHOOK_SECRET: z.preprocess(blankToUndefined, z.string().min(16, "ELEVENLABS_WEBHOOK_SECRET must be the signing secret of the webhook").optional()),
  ELEVENLABS_AGENT_MAP: z.preprocess(blankToUndefined, z.string().optional()),
  ELEVENLABS_AGENT_MAP_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  /** Name of the dynamic variable the business fills with the customer's number. */
  ELEVENLABS_CUSTOMER_PHONE_VARIABLE: z.preprocess(blankToUndefined, z.string().min(1).default("customer_phone")),
  /** Largest request body the route reads, in MiB. Audio deliveries are large. */
  ELEVENLABS_MAX_BODY_MB: z.coerce.number().int().min(1).max(512).default(100),
  /** Delivery attempts to the receiver before answering 503. */
  ELEVENLABS_FORWARD_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
});

/** The prefix setting may hold several prefixes separated by commas. */
export function analysisPrefixes(value: string): string[] {
  return value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

export type Config = z.infer<typeof schema> & {
  amazonConnectAwsCredentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** Validated agent map, empty when the ElevenLabs source is off. */
  elevenLabsAgentMap: AgentMap;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);

  if (parsed.AMAZON_CONNECT_CTR_RESOLVER === "s3" && !parsed.AMAZON_CONNECT_CTR_S3_BUCKET) {
    throw new Error("AMAZON_CONNECT_CTR_S3_BUCKET is required when AMAZON_CONNECT_CTR_RESOLVER=s3");
  }

  if (parsed.AMAZON_CONNECT_ENABLED && !parsed.INBOUND_API_KEY) {
    throw new Error("INBOUND_API_KEY must be set to a long random value when AMAZON_CONNECT_ENABLED is on");
  }
  if (parsed.ELEVENLABS_ENABLED && !parsed.ELEVENLABS_WEBHOOK_SECRET) {
    throw new Error("ELEVENLABS_WEBHOOK_SECRET is required when ELEVENLABS_ENABLED is on");
  }
  const elevenLabsAgentMap = parsed.ELEVENLABS_ENABLED
    ? loadAgentMap(parsed.ELEVENLABS_AGENT_MAP, parsed.ELEVENLABS_AGENT_MAP_FILE)
    : {};

  const amazonConnectAwsCredentials =
    parsed.AMAZON_CONNECT_AWS_ACCESS_KEY_ID && parsed.AMAZON_CONNECT_AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: parsed.AMAZON_CONNECT_AWS_ACCESS_KEY_ID,
          secretAccessKey: parsed.AMAZON_CONNECT_AWS_SECRET_ACCESS_KEY,
        }
      : undefined;

  return { ...parsed, amazonConnectAwsCredentials, elevenLabsAgentMap };
}
