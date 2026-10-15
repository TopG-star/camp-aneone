import { describe, it, expect } from "vitest";
import {
  CONNECTIONS_LOAD_FAILED,
  RECONNECT_HELP,
  UNLINK_WARNING,
  connectionTitle,
  endsText,
  formatDate,
  formatWhen,
  kindLabel,
  lastUsedText,
  reconnectLink,
  revokeFailureText,
  revokeNotice,
  revokeWarning,
  scopeText,
  unavailableNote,
  unlinkFailureText,
  unlinkWarning,
} from "./connections-ui";
import type { ContextsResponse } from "./context";

describe("Connections wording", () => {
  it("names what each kind of connection is for, in the person's words", () => {
    expect(kindLabel("attended")).toBe("Your sign-in");
    expect(kindLabel("action")).toBe("Approved action");
    expect(kindLabel("schedule")).toBe("Scheduled work");
  });

  it("says what a connection may do: its scope, or for a sign-in that it uses the person's own access", () => {
    expect(scopeText("action", ["inventory.transfer", "orders.read"])).toBe("inventory.transfer, orders.read");
    expect(scopeText("attended", [])).toBe("Your own access while you're signed in");
    expect(scopeText("action", [])).toBe("No specific permissions listed");
  });

  it("titles a connection with the kind and the pharmacy", () => {
    expect(connectionTitle({ kind: "attended", tenantName: "Acme Pharmacy" })).toBe("Your sign-in · Acme Pharmacy");
  });

  it("formats dates the way the other settings cards do", () => {
    expect(formatDate("2026-10-07T12:00:00.000Z")).toBe("7 Oct 2026");
    expect(formatDate("not a date")).toBe("an unknown date");
  });

  it("tells the truth about where a revoke reached: Oneon always, ImpressoRx only if it confirmed (not that it was unreachable: it may have refused, or never been asked)", () => {
    expect(revokeNotice("revoked", "2026-10-07T12:00:00.000Z")).toBe("Revoked in Oneon and at ImpressoRx.");
    expect(revokeNotice("unreachable", "2026-10-07T12:00:00.000Z", new Date("2026-10-01T09:00:00.000Z"))).toBe(
      "Revoked in Oneon. ImpressoRx didn't confirm it, so it may stay open there until 7 Oct 2026.",
    );
    expect(revokeNotice("unreachable", "2026-10-07T12:00:00.000Z", new Date("2026-10-07T09:00:00.000Z"))).toMatch(
      /^Revoked in Oneon\. ImpressoRx didn't confirm it, so it may stay open there until 7 Oct 2026, \d{2}:\d{2}\.$/,
    );
  });

  it("shows the time as well as the date only when it is less than a day away", () => {
    const now = new Date("2026-10-07T09:00:00.000Z");
    expect(formatWhen("2026-10-09T09:00:00.000Z", now)).toBe("9 Oct 2026");
    expect(formatWhen("2026-10-08T09:00:01.000Z", now)).toBe("8 Oct 2026"); // a day and a second away
    expect(formatWhen("2026-10-08T08:59:59.000Z", now)).toMatch(/^8 Oct 2026, \d{2}:\d{2}$/);
    expect(formatWhen("2026-10-07T09:30:00.000Z", now)).toMatch(/^7 Oct 2026, \d{2}:\d{2}$/);
    expect(formatWhen("2026-10-07T08:00:00.000Z", now)).toBe("7 Oct 2026"); // already past: just the date
    expect(formatWhen("not a date", now)).toBe("an unknown date");
  });

  it("says a connection has had no exchange yet, not that it was never used: the time only moves when it is exchanged", () => {
    expect(lastUsedText(null)).toBe("No exchange yet");
    expect(lastUsedText("2026-10-07T12:00:00.000Z")).toBe("Last used 7 Oct 2026");
    expect(endsText("2026-10-09T12:00:00.000Z", new Date("2026-10-07T09:00:00.000Z"))).toBe("Ends 9 Oct 2026 if unused");
    expect(endsText("2026-10-07T12:00:00.000Z", new Date("2026-10-07T09:00:00.000Z"))).toMatch(/^Ends 7 Oct 2026, \d{2}:\d{2} if unused$/);
  });

  it("warns before revoking the connection this session is signed in with, and not before any other", () => {
    expect(revokeWarning({ current: true, tenantName: "Acme Pharmacy" })).toBe(
      "This is the connection you're signed in with. Revoking it signs you out of Acme Pharmacy. Continue?",
    );
    expect(revokeWarning({ current: false, tenantName: "Acme Pharmacy" })).toBeNull();
  });

  it("explains each way a revoke or an unlink can fail without suggesting anything happened that did not", () => {
    expect(revokeFailureText(404)).toBe("That connection is no longer there.");
    expect(revokeFailureText(500)).toBe("Couldn't revoke this connection. Try again.");
    expect(unlinkFailureText(404)).toBe("That sign-in is no longer linked.");
    expect(unlinkFailureText(409)).toBe("That sign-in can't be unlinked. It may be the only one on your account.");
    expect(unlinkFailureText(500)).toBe("Couldn't unlink that sign-in. Try again.");
  });

  it("names the pharmacies that could not be checked, and how to reconnect", () => {
    expect(unavailableNote(["Beta Pharmacy"])).toBe("Couldn't check Beta Pharmacy right now.");
    expect(unavailableNote(["Acme Pharmacy", "Beta Pharmacy"])).toBe("Couldn't check Acme Pharmacy and Beta Pharmacy right now.");
    expect(unavailableNote([])).toBeNull();
    expect(RECONNECT_HELP).toBe("Open Oneon from ImpressoRx to reconnect, then retry the action.");
  });

  describe("where an action that needs a reconnect leads", () => {
    const tenant = (membershipId: string) => ({ kind: "tenant" as const, membershipId, tenantName: "Acme Pharmacy", role: "manager" });
    const item = { actionId: "a1", membershipId: "m-acme" };
    const contexts = (active: ContextsResponse["active"], available: ContextsResponse["available"]): ContextsResponse => ({ active, available });

    it("links straight to the action when the session is in that very membership", () => {
      expect(reconnectLink(item, contexts(tenant("m-acme"), [{ kind: "personal" }, tenant("m-acme")]))).toEqual({ kind: "open", href: "/actions#action-a1" });
    });

    it("offers a switch when the session may work in that membership but is in another context, and leads to the action afterwards", () => {
      expect(reconnectLink(item, contexts({ kind: "personal" }, [{ kind: "personal" }, tenant("m-acme")]))).toEqual({
        kind: "switch",
        choice: { kind: "tenant", membershipId: "m-acme" },
        href: "/actions#action-a1",
      });
      expect(reconnectLink(item, contexts(tenant("m-other"), [tenant("m-other"), tenant("m-acme")])).kind).toBe("switch");
    });

    it("gives only the reconnect text when the session cannot switch to that membership (a hand-off session is bound to one), or does not know yet", () => {
      expect(reconnectLink(item, contexts(tenant("m-other"), [tenant("m-other")]))).toEqual({ kind: "reconnect" });
      expect(reconnectLink(item, contexts({ kind: "personal" }, [{ kind: "personal" }]))).toEqual({ kind: "reconnect" });
      expect(reconnectLink(item, undefined)).toEqual({ kind: "reconnect" });
    });
  });

  it("warns before unlinking the sign-in this session came in through that it signs the person out", () => {
    expect(unlinkWarning({ current: false })).toBe(UNLINK_WARNING);
    expect(unlinkWarning({ current: true })).toBe(
      "This is the sign-in you're using now. Unlinking separates it from your account, revokes its connections and signs you out. Continue?",
    );
  });

  it("has fixed texts for loading failure and the unlink warning", () => {
    expect(CONNECTIONS_LOAD_FAILED).toBe("Couldn't load your connections.");
    expect(UNLINK_WARNING).toBe("Unlinking separates this pharmacy sign-in from your account and revokes its connections. Continue?");
  });
});
