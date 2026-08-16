/** Shared guards for untrusted process-local and socket data. */
const CONTROL_OR_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const CONTROL_OR_BIDI_GLOBAL_RE = new RegExp(CONTROL_OR_BIDI_RE.source, "g");
const PROTOCOL_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function hasControlOrBidi(value: string): boolean {
  return CONTROL_OR_BIDI_RE.test(value);
}

export function replaceControlOrBidi(value: string, replacement: string): string {
  return value.replace(CONTROL_OR_BIDI_GLOBAL_RE, replacement);
}

export function isProtocolToken(value: unknown): value is string {
  return typeof value === "string" && PROTOCOL_TOKEN_RE.test(value);
}
