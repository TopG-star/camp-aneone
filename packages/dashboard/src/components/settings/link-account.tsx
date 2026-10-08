"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Link2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HANDOFF_NOTICE, requestLink } from "@/lib/link-account";

/**
 * Spec §4.5: links the signed-in account to the other kind of sign-in in this same browser. The dashboard's server keeps
 * the intent; the answer says which sign-in finishes it. Until Settings → Connections exists (Task 20) this card lives on the Settings page.
 */
export function LinkAccountSettings() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function start() {
    setBusy(true);
    setMessage("");
    const result = await requestLink();
    if ("error" in result) {
      setMessage(result.error);
    } else if (result.next === "google") {
      // From a hand-off session: Google sign-in, which comes back to the link page.
      await signIn("google", { callbackUrl: "/auth/link/complete" });
      return;
    } else {
      // From a Google session: the person opens Oneon from ImpressoRx while the intent lives.
      setMessage(HANDOFF_NOTICE);
    }
    setBusy(false);
  }

  return (
    <Card id="link-account">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Linked accounts
        </CardTitle>
        <p className="text-label-sm meta-copy">
          Bring your pharmacy sign-in and your personal Oneon account together. Both sign-ins have to happen in this browser.
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Button size="sm" variant="secondary" disabled={busy} onClick={start}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Link your personal Oneon account
          </Button>
          {message && (
            <p role="status" className="text-sm text-on-surface/80 dark:text-dark-on-surface/80">
              {message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
