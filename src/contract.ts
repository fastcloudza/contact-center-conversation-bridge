/**
 * Shared helpers for the request shape a receiver of finished calls expects:
 * the customer number rules and the time rules. Every source uses them, so the
 * three sources look alike to the receiver.
 */

/** The placeholder sent when no usable customer number is known. */
export const ANONYMOUS = "anonymous";

/** Strips spaces and dashes, turns a leading 0 into +27, and otherwise adds a plus. */
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s-]/g, "");
  if (p.startsWith("0")) p = "+27" + p.slice(1);
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

/** A usable number has 8 to 15 digits. Returns the normalized number, or null. */
export function usablePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? normalizePhone(value) : null;
}

export interface PhoneResolution {
  /** The normalized number, or the literal "anonymous". */
  phone: string;
  /** Where the number came from, or "none". */
  source: string;
  /** True when a value was present but was not a usable number. */
  rejectedCandidate: boolean;
}

/** One candidate number from a source that names where it found it. */
export function resolveCustomerPhone(candidate: unknown, source: string | null | undefined): PhoneResolution {
  if (candidate === undefined || candidate === null || candidate === "") {
    return { phone: ANONYMOUS, source: "none", rejectedCandidate: false };
  }
  const phone = usablePhone(candidate);
  if (phone) return { phone, source: source || "source", rejectedCandidate: false };
  return { phone: ANONYMOUS, source: "none", rejectedCandidate: true };
}

/** Seconds since the epoch for an ISO 8601 time, or null when it does not parse. */
export function toEpochSeconds(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Rounds to thousandths of a second. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
