import { describe, it, expect } from "vitest";
import {
  CONNECTIONS_LOAD_FAILED,
  RECONNECT_HELP,
  UNLINK_WARNING,
  connectionTitle,
  formatDate,
  kindLabel,
  revokeFailureText,
  revokeNotice,
  revokeWarning,
  scopeText,
  unavailableNote,
  unlinkFailureText,
} from "./connections-ui";

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

  it("tells the truth about where a revoke reached: Oneon always, ImpressoRx only if it answered", () => {
    expect(revokeNotice("revoked", "2026-10-07T12:00:00.000Z")).toBe("Revoked in Oneon and at ImpressoRx.");
    expect(revokeNotice("unreachable", "2026-10-07T12:00:00.000Z")).toBe(
      "Revoked in Oneon. ImpressoRx couldn't be reached; this connection expires on 7 Oct 2026.",
    );
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

  it("has fixed texts for loading failure and the unlink warning", () => {
    expect(CONNECTIONS_LOAD_FAILED).toBe("Couldn't load your connections.");
    expect(UNLINK_WARNING).toBe("Unlinking separates this pharmacy sign-in from your account and revokes its connections. Continue?");
  });
});
