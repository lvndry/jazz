import { describe, expect, test } from "bun:test";
import { createEscalationLedger } from "./escalation";

describe("EscalationLedger", () => {
  test("a command that was never denied has no offer", () => {
    const ledger = createEscalationLedger();
    expect(ledger.peek("run-1", "rm x")).toBeUndefined();
    expect(ledger.consume("run-1", "rm x")).toBe(false);
  });

  test("an offer is spent exactly once", () => {
    const ledger = createEscalationLedger();
    ledger.offer("run-1", "touch /etc/x", "/etc/x");
    expect(ledger.peek("run-1", "touch /etc/x")).toBe("/etc/x");
    expect(ledger.consume("run-1", "touch /etc/x")).toBe(true);
    expect(ledger.consume("run-1", "touch /etc/x")).toBe(false);
    expect(ledger.peek("run-1", "touch /etc/x")).toBeUndefined();
  });

  test("an offer is bound to its run and its exact command", () => {
    const ledger = createEscalationLedger();
    ledger.offer("run-1", "touch /etc/x", "/etc/x");
    expect(ledger.peek("run-2", "touch /etc/x")).toBeUndefined();
    expect(ledger.peek("run-1", "touch /etc/y")).toBeUndefined();
  });

  test("surrounding whitespace does not make a different command", () => {
    const ledger = createEscalationLedger();
    ledger.offer("run-1", "touch /etc/x", "/etc/x");
    expect(ledger.consume("run-1", "  touch /etc/x\n")).toBe(true);
  });

  test("past its bound the oldest offer is dropped", () => {
    const ledger = createEscalationLedger(2);
    ledger.offer("run", "a", "/a");
    ledger.offer("run", "b", "/b");
    ledger.offer("run", "c", "/c");
    expect(ledger.peek("run", "a")).toBeUndefined();
    expect(ledger.peek("run", "b")).toBe("/b");
    expect(ledger.peek("run", "c")).toBe("/c");
  });
});
