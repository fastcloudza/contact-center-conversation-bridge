/** ElevenLabs specific shapes. Nothing outside this folder imports these.
 *
 * Source: ElevenLabs public documentation (post call webhooks, conversation
 * details, dynamic variables), read on 16 November 2026. No real delivery has
 * been captured yet, so every field here is optional and the mapper never
 * assumes more than the documentation states. Unknown keys must be accepted,
 * the documentation asks for that explicitly.
 */
export interface ElevenLabsTranscriptEntry {
  role?: "user" | "agent" | string;
  /** Null or absent for entries that only carry a tool call or result. */
  message?: string | null;
  /** Whole seconds from the start of the conversation. */
  time_in_call_secs?: number;
  interrupted?: boolean;
  [key: string]: unknown;
}

export interface ElevenLabsPhoneCall {
  /** Documented values: "inbound" and "outbound". */
  direction?: string;
  /** Documented without a description. Which party is the customer is not documented. */
  agent_number?: string;
  /** Documented without a description. Which party is the customer is not documented. */
  external_number?: string;
  [key: string]: unknown;
}

export interface ElevenLabsMetadata {
  start_time_unix_secs?: number;
  call_duration_secs?: number;
  phone_call?: ElevenLabsPhoneCall;
  /** The documented field name says whose number it is: the SMS user's. */
  sms?: { sms_user_phone_number?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ElevenLabsConversationData {
  agent_id?: string;
  agent_name?: string;
  conversation_id?: string;
  status?: string;
  transcript?: ElevenLabsTranscriptEntry[];
  metadata?: ElevenLabsMetadata;
  analysis?: { transcript_summary?: string; [key: string]: unknown };
  conversation_initiation_client_data?: {
    /** Names to any JSON value. Includes the documented system__ variables. */
    dynamic_variables?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ElevenLabsEvent {
  type?: string;
  event_timestamp?: number;
  data?: ElevenLabsConversationData;
  [key: string]: unknown;
}
