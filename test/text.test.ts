import { expect, test } from "bun:test";
import { boundedPresenceText } from "../src/text.js";
test("text is byte bounded",()=>expect(Buffer.byteLength(boundedPresenceText("😀".repeat(200),{maxBytes:128,maxCodePoints:96}),"utf8")).toBeLessThanOrEqual(128));
test("text is codepoint bounded",()=>expect([...boundedPresenceText("x".repeat(200),{maxBytes:128,maxCodePoints:96})]).toHaveLength(96));
test("text strips controls",()=>expect(boundedPresenceText("ok\u0000bad",{maxBytes:128,maxCodePoints:96})).toBe("ok bad"));
test("text has deterministic fallback",()=>expect(boundedPresenceText("",{maxBytes:128,maxCodePoints:96})).toBe("presence"));
