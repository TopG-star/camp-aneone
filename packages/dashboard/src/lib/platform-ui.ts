/** Registration statuses as the agent-server's platform view reports them (spec §5.2). */
export type RegistrationStatus = "active" | "suspended_by_operator" | "disabled_by_tenant" | "removed";

/** What the operator is told about a registration: whether Oneon serves it, and who switched it off. */
export function registrationStatusText(status: RegistrationStatus): string {
  switch (status) {
    case "active":
      return "Served by Oneon.";
    case "suspended_by_operator":
      return "Suspended by a platform operator: Oneon is not serving this pharmacy. ImpressoRx is unchanged.";
    case "disabled_by_tenant":
      return "The pharmacy switched Oneon off in ImpressoRx.";
    case "removed":
      return "Removed: Oneon no longer serves this pharmacy.";
  }
}

/** ImpressoRx's Tenant.id: the pharmacy's permanent identity, which the slug (only a name) is not. */
export function impressorxTenantIdText(impressorxTenantId: string): string {
  return `ImpressoRx tenant id: ${impressorxTenantId}`;
}

/** The one console action a registration offers: Resume undoes only an operator's own suspension. */
export function registrationAction(status: RegistrationStatus): "suspend" | "resume" | null {
  if (status === "active") return "suspend";
  if (status === "suspended_by_operator") return "resume";
  return null;
}

export function suspendConfirmation(name: string): string {
  return `Suspend ${name}? Oneon stops serving it at once: its staff can't open it in Oneon, and nightly jobs skip it. Its file is still backed up. Nothing changes in ImpressoRx, and you can resume it later.`;
}

export function resumeConfirmation(name: string): string {
  return `Resume ${name}? Oneon first brings its file up to date and refreshes its ImpressoRx keys; if either fails it stays suspended and you see why. Then Oneon serves it again.`;
}
