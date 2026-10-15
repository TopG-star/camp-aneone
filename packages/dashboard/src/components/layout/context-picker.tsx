"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Building2, User } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useContexts } from "@/lib/hooks";
import { choiceApplied, contextChoice, contextLabel, contextValue, pickerOptions, pickerVisible } from "@/lib/context";

/**
 * Switches between the personal context and the pharmacies this session may work in. Choosing one asks the agent-server
 * first (so launch_required or a suspended pharmacy is shown here and nothing changes), then stores the choice in the
 * session and reloads the chat page, which drops the conversation and every cached list of the context just left.
 * A session that has only one context shows it as a label; one with only the personal context shows nothing.
 */
export function ContextPicker() {
  const { update } = useSession();
  const { data } = useContexts();
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  if (!data || !pickerVisible(data)) return null;
  const options = pickerOptions(data);
  const Icon = data.active.kind === "personal" ? User : Building2;

  async function choose(value: string) {
    const option = options.find((o) => contextValue(o) === value);
    if (!option || contextValue(option) === contextValue(data!.active)) return;
    setError(null);
    setSwitching(true);
    try {
      const choice = contextChoice(option);
      await apiFetch("/api/contexts/validate", { method: "POST", body: JSON.stringify(choice) }, { redirectOnAuth: false });
      const updated = await update({ activeContext: choice });
      // The session callback re-validates on the server; if it refused, the session still holds the old context.
      if (!updated || !choiceApplied(updated.activeContext, choice)) {
        setError("Your session didn't accept the switch, so you are still in the same context. Please try again.");
        setSwitching(false);
        return;
      }
      window.location.assign("/chat");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't switch context");
      setSwitching(false);
    }
  }

  return (
    <div className="relative flex min-w-0 items-center">
      <div className="flex min-w-0 items-center gap-1.5 text-label-sm meta-copy">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {options.length > 1 ? (
          <select
            aria-label="Context"
            className="max-w-[12rem] truncate rounded-eight bg-transparent py-1 text-label-sm text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:text-dark-on-surface dark:focus-visible:ring-dark-primary/45"
            value={contextValue(data.active)}
            disabled={switching}
            onChange={(e) => void choose(e.target.value)}
          >
            {options.map((o) => (
              <option key={contextValue(o)} value={contextValue(o)}>
                {contextLabel(o)}
              </option>
            ))}
          </select>
        ) : (
          <span className="max-w-[12rem] truncate">{contextLabel(data.active)}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="state-error absolute right-0 top-full z-30 mt-1 w-64 rounded-eight bg-surface p-2 text-label-sm shadow-lg dark:bg-dark-surface">
          {error}
        </p>
      )}
    </div>
  );
}
