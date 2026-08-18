import { expect } from "bun:test";
import { HERDR_LEGACY_METADATA_TOKEN_KEYS, HERDR_METADATA_TOKEN_KEYS, isExactAgentAuthorityClearParams, isExactLegacyMetadataClearParams, isExactMetadataClearParams, isExactMetadataIngressParams } from "../../src/protocol.js";

const envelopeKeys = ["pane_id", "source", "applies_to_source", "agent", "seq", "title", "display_agent", "state_labels", "tokens"];
const clearEnvelopeKeys = ["pane_id", "source", "applies_to_source", "agent", "seq", "clear_title", "clear_display_agent", "clear_state_labels", "tokens"];
const legacyClearEnvelopeKeys = ["pane_id", "source", "applies_to_source", "agent", "seq", "tokens"];

/** Reusable assertion for the reviewed upstream Herdr v8 metadata variants. */
export function expectExactMetadataIngress(params: unknown): void {
  expect(isExactMetadataIngressParams(params)).toBe(true);
  expect(Object.keys(params as object)).toEqual(envelopeKeys);
  const metadata = params as { seq: unknown; tokens: Record<string, unknown>; title: unknown; display_agent: unknown; state_labels: unknown };
  expect(metadata.seq).toEqual(expect.any(Number));
  expect(metadata.title).toBe("Pi");
  expect(metadata.display_agent).toBe("Pi");
  expect(metadata.state_labels).toEqual({ idle: "Pi is idle", working: "Pi is working", blocked: "Pi needs attention", unknown: "Pi state unknown" });
  expect(Object.keys(metadata.tokens)).toEqual([...HERDR_METADATA_TOKEN_KEYS]);
}

export function expectExactMetadataClear(params: unknown): void {
  expect(isExactMetadataClearParams(params)).toBe(true);
  expect(Object.keys(params as object)).toEqual(clearEnvelopeKeys);
  const metadata = params as { tokens: Record<string, unknown> };
  expect(Object.keys(metadata.tokens)).toEqual([...HERDR_METADATA_TOKEN_KEYS]);
  expect(Object.values(metadata.tokens)).toEqual(Array(HERDR_METADATA_TOKEN_KEYS.length).fill(null));
}

export function expectExactLegacyMetadataClear(params: unknown): void {
  expect(isExactLegacyMetadataClearParams(params)).toBe(true);
  expect(Object.keys(params as object)).toEqual(legacyClearEnvelopeKeys);
  const metadata = params as { tokens: Record<string, unknown> };
  expect(Object.keys(metadata.tokens)).toEqual([...HERDR_LEGACY_METADATA_TOKEN_KEYS]);
  expect(Object.values(metadata.tokens)).toEqual(Array(HERDR_LEGACY_METADATA_TOKEN_KEYS.length).fill(null));
  expect(JSON.stringify(params)).not.toContain("path");
  expect(JSON.stringify(params)).not.toContain("title");
}

export function expectExactAgentAuthorityClear(params: unknown): void {
  expect(isExactAgentAuthorityClearParams(params)).toBe(true);
  expect(Object.keys(params as object)).toEqual(["pane_id", "source", "seq"]);
  expect(JSON.stringify(params)).not.toContain("agent");
  expect(JSON.stringify(params)).not.toContain("path");
}
