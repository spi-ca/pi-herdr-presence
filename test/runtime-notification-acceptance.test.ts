import { expect, test } from "bun:test";
import { shouldNotifyAttention } from "../src/notification-policy.js";
/** Notification acceptance is policy-only; runtime additionally fences by event generation/sequence and turn. */
test("notification acceptance keeps cancellation silent and permits new external terminal events",()=>{expect(shouldNotifyAttention("all",true,"none","external")).toBe(false);expect(shouldNotifyAttention("all",true,"error","external")).toBe(true);expect(shouldNotifyAttention("background",true,"success","local")).toBe(false);expect(shouldNotifyAttention("background",true,"success","external")).toBe(true);});
