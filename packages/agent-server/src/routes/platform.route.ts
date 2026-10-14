import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import {
  EnrolmentFailedError,
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
  logger: Logger;
}

const EnrolBody = z.object({
  origin: z.string().url().max(300),
  tenantSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  code: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export function createPlatformRouter(deps: PlatformRouteDeps): Router {
  const router = Router();
  const { operators, registrations, enrolment, backupConfigured, grantConfigured, latestRollups, createTenantFile, logger } = deps;

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
    if (registrations.findBySlug(tenantSlug)) {
      res.status(409).json({ error: "That tenant is already enrolled" });
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
      if (error instanceof EnrolmentFailedError) {
        logger.warn("Enrolment failed", { tenantSlug });
        res.status(502).json({ error: "Enrolment failed" });
        return;
      }
      logger.error("Enrolment error", { tenantSlug, error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

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
      // The operator names the registration to act on, as for rotate-key; this is not the request's active context.
      const id = String(req.params.id);
      const result = registrations.transitionStatus(id, t.from, t.to, req.identityId!, t.reason);
      if (result === "unknown") {
        res.status(404).json({ error: "No such registration" });
        return;
      }
      if (result === "conflict") {
        res.status(409).json({ error: action === "suspend" ? "Only an active pharmacy can be suspended" : "Only a pharmacy you suspended can be resumed" });
        return;
      }
      logger.info(t.log, { registrationId: id });
      res.status(204).end();
    });
  }

  router.post("/registrations/:id/rotate-key", async (req: Request, res: Response) => {
    try {
      await enrolment.rotateOneonKey(String(req.params.id), req.identityId!);
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
