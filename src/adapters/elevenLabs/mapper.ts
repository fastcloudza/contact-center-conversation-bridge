import type { AgentMap } from "../../config.js";
import type { ElevenLabsConversationData } from "./types.js";

type AgentEntry = AgentMap[string];

/** One turn of a finished call: speaker, text, start and end in seconds, language and source. */
export interface CallTurn {
  speaker: "agent" | "customer";
  text: string;
  /** Seconds from the start of the conversation. */
  start: number;
  /** Seconds. ElevenLabs gives no end, so it equals start. */
  end: number;
  language: string;
  /** "llm" marks an AI agent turn, "caller" a customer turn. */
  source: string;
  cut_off: boolean;
  text_known: boolean;
}

/** The request body for a finished call, in the shape a receiver of call recordings accepts. */
export interface CallRequest {
  customer_phone: string;
  agent_extension: string;
  company_id: string;
  waba_id: string;
  waba_phone: string;
  conversation: CallTurn[];
  call_direction: string;
  call_duration: number;
  call_uuid: string;
  timestamp: string;
  recording_filename: string | null;
  widget_source: string;
  widget_token: string;
  referring_domain: string;
  conversation_source: string;
  tap_uuid: string;
  call_start_epoch?: number;
  /** Free form. The receiver ignores keys it does not know. */
  raw: Record<string, unknown>;
}

export type PhoneSource = "none" | "dynamic_variable" | "sms_user_phone_number" | "system__caller_id";

export interface CustomerPhone {
  phone: string | null;
  source: PhoneSource;
  /** True when a candidate field was present but was not a usable number. */
  rejectedCandidate: boolean;
}

/** The placeholder sent when no customer number is known. */
export const ANONYMOUS = "anonymous";

/** Strips spaces and dashes, turns a leading 0 into +27, and otherwise adds a plus. */
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s-]/g, "");
  if (p.startsWith("0")) p = "+27" + p.slice(1);
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

/** A usable number has 8 to 15 digits. */
function usable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? normalizePhone(value) : null;
}

/**
 * Finds the customer's number in fields whose documented meaning is the
 * customer's, in this order:
 *  1. the dynamic variable the business fills with it (name set in settings),
 *  2. metadata.sms.sms_user_phone_number,
 *  3. the documented system__caller_id, only for a call documented as inbound.
 * It never reads the transcript and never chooses between agent_number and
 * external_number, because the documentation does not say which is the customer.
 */
export function findCustomerPhone(data: ElevenLabsConversationData, variableName: string): CustomerPhone {
  const vars = data.conversation_initiation_client_data?.dynamic_variables ?? {};
  const candidates: { source: PhoneSource; value: unknown; allowed: boolean }[] = [
    { source: "dynamic_variable", value: vars[variableName], allowed: true },
    { source: "sms_user_phone_number", value: data.metadata?.sms?.sms_user_phone_number, allowed: true },
    { source: "system__caller_id", value: vars["system__caller_id"], allowed: data.metadata?.phone_call?.direction === "inbound" },
  ];
  let rejectedCandidate = false;
  for (const c of candidates) {
    if (!c.allowed || c.value === undefined || c.value === null || c.value === "") continue;
    const phone = usable(c.value);
    if (phone) return { phone, source: c.source, rejectedCandidate };
    rejectedCandidate = true;
  }
  return { phone: null, source: "none", rejectedCandidate };
}

function seconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface MapResult {
  payload: CallRequest;
  skippedEntries: number;
}

/** A finished ElevenLabs conversation into the request body for a finished call. */
export function mapToCallRequest(
  data: ElevenLabsConversationData,
  agent: AgentEntry,
  options: { customerPhoneVariable: string; now?: Date },
): MapResult {
  const entries = Array.isArray(data.transcript) ? data.transcript : [];
  const conversation: CallTurn[] = [];
  for (const entry of entries) {
    const text = typeof entry?.message === "string" ? entry.message.trim() : "";
    const speaker = entry?.role === "agent" ? "agent" : entry?.role === "user" ? "customer" : null;
    if (!text || !speaker) continue;
    const start = seconds(entry.time_in_call_secs);
    conversation.push({
      speaker,
      text,
      start,
      end: start,
      language: "en",
      source: speaker === "agent" ? "llm" : "caller",
      cut_off: false,
      text_known: true,
    });
  }

  const found = findCustomerPhone(data, options.customerPhoneVariable);
  const startEpoch = data.metadata?.start_time_unix_secs;
  const duration = data.metadata?.call_duration_secs;
  const direction = data.metadata?.phone_call?.direction;

  const payload: CallRequest = {
    customer_phone: found.phone ?? ANONYMOUS,
    agent_extension: agent.agentExtension ?? "",
    company_id: agent.companyId ?? "",
    waba_id: agent.wabaId,
    waba_phone: normalizePhone(agent.wabaPhone),
    conversation,
    call_direction: direction === "outbound" ? "outbound" : "inbound",
    call_duration: typeof duration === "number" && Number.isFinite(duration) ? Math.trunc(duration) : 0,
    call_uuid: String(data.conversation_id),
    timestamp: (options.now ?? new Date()).toISOString(),
    recording_filename: null,
    widget_source: "",
    widget_token: "",
    referring_domain: "",
    conversation_source: "elevenlabs",
    tap_uuid: "",
    raw: {
      source: "elevenlabs",
      agentId: data.agent_id,
      customerPhoneSource: found.source,
      customerPhoneCandidateRejected: found.rejectedCandidate,
      skippedEntries: entries.length - conversation.length,
    },
  };
  if (typeof startEpoch === "number" && Number.isFinite(startEpoch) && startEpoch > 0 && startEpoch < 1e10) {
    payload.call_start_epoch = startEpoch;
  }
  return { payload, skippedEntries: entries.length - conversation.length };
}
