import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import {
  EnrolmentFailedError,
  EnrolmentNotStoredError,
  ReenrolmentRefusedError,
  type EnrolmentService,
  type PlatformOperatorRepository,
  type TenantRegistrationRepository,
} from "@oneon/infrastructure";

export interface PlatformRouteDeps {
  operators: PlatformOperatorRepository;
  registrations: TenantRegistrationRepository;
  enrolment: EnrolmentService;
  /** True when BACKUP_ENCRYPTION_KEY is set. Without it a registration would stop the next restart, so enrolment is refused. */
  backupConfigured: boolean;
  /** True when ONEON_GRANT_MASTER_KEY is set. Without it no hand-off can be proved, so enrolment is refused. */
  grantConfigured: boolean;
  /** Each tenant's most recent rollup, read from the control database. The platform view never opens a tenant file. */
  latestRollups: () => Array<{ tenantId: string; day: string; metrics: unknown }>;
  /** Creates the tenant's database file once its registration exists. */
  createTenantFile: (registrationId: string, tenantId: string) => void;
  /** Tells the gate a registration stopped being servable: its open file closes now, or at the last release if something still uses it. */
  detachTenant: (registrationId: string) => void;
  /** Revokes every grant of a registration locally (the ImpressoRx client's revokeForRegistration). Re-enrolment calls it. */
  revokeGrantsForRegistration: (registrationId: string, reason: string) => void;
  logger: Logger;
}

/**
 * Every failure after the code is spent ends with this (review I2). ImpressoRx has already claimed the code and shows Oneon as
 * connected, and while it does it issues no new code: Enable alone does nothing, so Remove comes first. Oneon does not undo the
 * connection at ImpressoRx itself (owner decision D4).
 */
const CONNECTED_ON_IMPRESSORX =
  "ImpressoRx now shows Oneon as connected on its side. The pharmacy's ImpressoRx admin must press Remove, then Enable, to issue a new code.";

const EnrolBody = z.object({
  origin: z.string().url().max(300),
  tenantSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  code: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export function createPlatformRouter(deps: PlatformRouteDeps): Router {
  const router = Router();
  const { operators, registrations, enrolment, backupConfigured, grantConfigured, latestRollups, createTenantFile, detachTenant, revokeGrantsForRegistration, logger } =
    deps;

  // Operator only. A signed-in user who is not an operator gets 403, never a hint of what exists.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.identityId || !operators.isOperator(req.identityId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });

  router.post("/enrolments", async (req: Request, res: Response) => {
    // Refused before the code is spent or anything is written: each key is needed by the registration from its first minute.
    const missing = [
      !backupConfigured && "BACKUP_ENCRYPTION_KEY",
      !enrolment.configured && "ONEON_SIGNING_KEY_MASTER_KEY",
      !grantConfigured && "ONEON_GRANT_MASTER_KEY",
    ].filter((key): key is string => Boolean(key));
    if (missing.length > 0) {
      res.status(503).json({
        error: `Enrolment is disabled until ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set on the server (generate each with: openssl rand -base64 32) and the server is restarted`,
      });
      return;
    }
    const parsed = EnrolBody.safeParse(req.body);
    if (!parsed.success || new URL(parsed.data.origin).protocol !== "https:") {
      res.status(400).json({ error: "Enter an HTTPS origin, the tenant slug and the enrolment code" });
      return;
    }
    const { origin, tenantSlug, code, displayName } = parsed.data;
    const existing = registrations.findBySlug(tenantSlug);
    if (existing) {
      // Ruling: an existing slug is enrolled again only while an operator has it suspended, only at its pinned origin, and only
      // with the full two-sided proof. Both refusals come before the code is spent.
      if (existing.status !== "suspended_by_operator") {
        res.status(409).json({ error: "That tenant is already enrolled. Suspend it first to enrol it again." });
        return;
      }
      if (new URL(origin).origin !== existing.origin) {
        res.status(409).json({
          error: `That pharmacy is enrolled at ${existing.origin}. Re-enrolment must use the same origin; moving a pharmacy to a new origin is a manual procedure (see DEPLOY.md).`,
        });
        return;
      }
      try {
        await enrolment.reenrol({
          registrationId: existing.id,
          origin,
          enrolmentCode: code,
          reenrolledBy: req.identityId!,
          inTransaction: () => revokeGrantsForRegistration(existing.id, "reenrolled"),
        });
        logger.info("Pharmacy re-enrolled", { registrationId: existing.id });
        res.status(200).json({ registrationId: existing.id, tenantSlug, reenrolled: true });
      } catch (error) {
        enrolmentFailure(res, error, tenantSlug, "Re-enrolment");
      }
      return;
    }

    try {
      // The tenant file is created inside the registration's transaction: if it fails, nothing is stored.
      const registration = await enrolment.enrol({
        origin,
        tenantSlug,
        enrolmentCode: code,
        displayName,
        enrolledBy: req.identityId!,
        inTransaction: (r) => createTenantFile(r.id, r.tenantId),
      });
      res.status(201).json({ registrationId: registration.id, tenantSlug: registration.tenantSlug });
    } catch (error) {
      enrolmentFailure(res, error, tenantSlug, "Enrolment");
    }
  });

  /**
   * Every failure answers an explicit status and message (review I2): 409 for a race or a conflict, 502 where the deployment's answer
   * was wrong, and an explicit 500 when storing failed. Each one after the code was spent says what the pharmacy's admin must do.
   */
  function enrolmentFailure(res: Response, error: unknown, tenantSlug: string, what: "Enrolment" | "Re-enrolment"): void {
    if (error instanceof ReenrolmentRefusedError) {
      // The route checks both before the code is spent; the service checks again, so this only answers a change in between.
      res.status(409).json({
        error:
          error.reason === "not_suspended"
            ? "That tenant is no longer suspended. Nothing was sent, so the code is still valid."
            : "Re-enrolment must use the pharmacy's pinned origin. Nothing was sent, so the code is still valid.",
      });
      return;
    }
    if (error instanceof EnrolmentFailedError) {
      logger.warn(`${what} failed`, { tenantSlug, reason: error.reason ?? null });
      const notStored = `Nothing was stored. ${CONNECTED_ON_IMPRESSORX}`;
      const explained: Partial<Record<NonNullable<EnrolmentFailedError["reason"]>, [number, string]>> = {
        slug_mismatch: [502, `The deployment answered for a different pharmacy than ${tenantSlug}. ${notStored}`],
        impressorx_tenant_mismatch: [
          502,
          `The deployment answered as a different pharmacy from the one enrolled as ${tenantSlug}: it was set up again, or its ` +
            "database was replaced. The registration and its data stay with the original pharmacy; nothing was changed. ImpressoRx now " +
            "shows Oneon as connected on its side, so its admin must press Remove there. A new code (Remove, then Enable) is refused the " +
            "same way while that deployment holds a different pharmacy.",
        ],
        impressorx_tenant_already_enrolled: [409, `That pharmacy is already enrolled under another slug. ${notStored}`],
        impressorx_tenant_id_missing: [
          502,
          `The deployment did not say which pharmacy it is. Update ImpressoRx to a release that sends its tenant id. ${notStored}`,
        ],
      };
      const [status, message] = (error.reason && explained[error.reason]) ?? [502, `${what} failed`];
      res.status(status).json({ error: message });
      return;
    }
    if (error instanceof EnrolmentNotStoredError) {
      const conflicts: Partial<Record<EnrolmentNotStoredError["reason"], string>> = {
        registration_changed: `${tenantSlug} is no longer suspended: another operation changed it while the deployment was answering, so nothing was stored.`,
        slug_taken: `Another registration took the slug ${tenantSlug} while the deployment was answering, so nothing was stored.`,
        impressorx_tenant_taken: "Another registration took this pharmacy's ImpressoRx tenant id while the deployment was answering, so nothing was stored.",
      };
      const conflict = conflicts[error.reason];
      if (conflict) {
        logger.warn(`${what} failed`, { tenantSlug, reason: error.reason });
        res.status(409).json({ error: `${conflict} ${CONNECTED_ON_IMPRESSORX}` });
        return;
      }
      const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
      logger.error(`${what} error`, { tenantSlug, error: cause });
      res.status(500).json({ error: `${what} could not be stored (the error is in the server log), so nothing was stored. ${CONNECTED_ON_IMPRESSORX}` });
      return;
    }
    // Only an error before the code was spent gets here.
    logger.error(`${what} error`, { tenantSlug, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Internal server error" });
  }

  router.get("/registrations", (_req: Request, res: Response) => {
    res.json({
      registrations: registrations.listActive().map((r) => ({
        id: r.id,
        tenantSlug: r.tenantSlug,
        displayName: r.displayName,
        origin: r.origin,
        enrolledAt: r.enrolledAt,
      })),
    });
  });

  // Every registration, suspended ones included, so the operator can resume them.
  router.get("/tenants", (_req: Request, res: Response) => {
    const rollups = new Map(latestRollups().map((r) => [r.tenantId, { day: r.day, metrics: r.metrics }]));
    res.json({
      tenants: registrations.listAll().map((r) => ({
        id: r.id,
        tenantSlug: r.tenantSlug,
        impressorxTenantId: r.impressorxTenantId,
        displayName: r.displayName,
        origin: r.origin,
        enrolledAt: r.enrolledAt,
        status: r.status,
        latestRollup: rollups.get(r.tenantId) ?? null,
      })),
    });
  });

  // Spec §5.5 Suspend: Oneon stops serving the pharmacy (the gate refuses every open, cached handles included); ImpressoRx is unchanged.
  // Resume undoes only an operator suspension. Each change is one status_changed event and a log line.
  const transitions = {
    suspend: { from: "active", to: "suspended_by_operator", reason: "operator_suspend", log: "Pharmacy suspended by operator" },
    resume: { from: "suspended_by_operator", to: "active", reason: "operator_resume", log: "Pharmacy resumed by operator" },
  } as const;
  for (const [action, t] of Object.entries(transitions)) {
    router.post(`/registrations/:id/${action}`, (req: Request, res: Response) => {
      const registrationId = String(req.params.id);
      const result = registrations.transitionStatus(registrationId, t.from, t.to, req.identityId!, t.reason);
      if (result === "unknown") {
        res.status(404).json({ error: "No such registration" });
        return;
      }
      if (result === "conflict") {
        res.status(409).json({ error: action === "suspend" ? "Only an active pharmacy can be suspended" : "Only a pharmacy you suspended can be resumed" });
        return;
      }
      // A move away from active: the gate would only notice at the next lease attempt, so it is told now.
      if (t.to !== "active") detachTenant(registrationId);
      logger.info(t.log, { registrationId });
      res.status(204).end();
    });
  }

  router.post("/registrations/:id/rotate-key", async (req: Request, res: Response) => {
    try {
      const registrationId = String(req.params.id);
      await enrolment.rotateOneonKey(registrationId, req.identityId!);
      res.status(204).end();
    } catch (error) {
      if (error instanceof EnrolmentFailedError) {
        res.status(502).json({ error: "Key rotation failed" });
        return;
      }
      logger.error("Key rotation error", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
