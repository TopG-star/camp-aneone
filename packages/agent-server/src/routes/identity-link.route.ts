import { Router } from "express";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import { UnlinkRefusedError, type IdentityRepository, type LinkIntentRepository } from "@oneon/infrastructure";

export interface IdentityLinkDeps {
  identities: Pick<
    IdentityRepository,
    "findByLogin" | "findById" | "hasLogin" | "attachGoogleSubByEmailOnce" | "attachLogin" | "mergeInto" | "unlink"
  >;
  intents: Pick<LinkIntentRepository, "create" | "consume">;
  /** Makes sure the identity has a row in the personal database, whose foreign keys point at users(id). */
  ensurePersonalUser: (user: { id: string; email: string }) => void;
  logger: Logger;
}

/**
 * The second sign-in, as the dashboard's server side reports it. A Google login is identified by Google's `sub`. A hand-off
 * has no subject the dashboard knows: it signed in as an identity the agent-server itself created, so it names that.
 */
const LoginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("google"),
    subject: z.string().min(1).max(256),
    email: z.string().min(3).max(320).transform((email) => email.toLowerCase()),
  }),
  z.object({ kind: z.literal("impressorx"), identityId: z.string().min(1).max(64) }),
]);
type Login = z.infer<typeof LoginSchema>;

// An empty secret is a request without the browser's secret: refused as link_expired like any other, not as malformed.
const LinkBodySchema = z.object({
  linkIntentId: z.string().max(64),
  secret: z.string().max(256),
  login: LoginSchema,
});

const UnlinkBodySchema = z.object({ loginIdentityId: z.string().min(1).max(64) });

const CONFLICT = { error: "link_conflict" } as const;

type LinkOutcome = { merged: boolean; identityId: string } | "conflict";

/**
 * Decides what the second login means for the identity that opened the intent. Linking is only ever what the person just
 * did in this browser: two logins that merely share an email are never joined.
 */
function link(deps: IdentityLinkDeps, creatorId: string, login: Login): LinkOutcome {
  const { identities } = deps;
  const second =
    login.kind === "google"
      ? // The one-time pre-upgrade step (spec §4.2) may be what first meets this Google login; it is not a link.
        (identities.findByLogin("google", login.subject) ?? identities.attachGoogleSubByEmailOnce(login.email, login.subject))
      : identities.hasLogin(login.identityId, "impressorx")
        ? identities.findById(login.identityId)
        : null;
  const creator = identities.findById(creatorId);
  if (!creator || creator.status !== "active" || (second && second.status !== "active")) return "conflict";
  if (second?.id === creator.id) return { merged: false, identityId: creator.id };

  if (!second) {
    // Nobody holds this Google login yet: it joins the current identity. (A hand-off's identity exists before its sign-in
    // reaches us, so only a Google login can be new here.) One identity does not hold two Google logins.
    if (login.kind !== "google" || identities.hasLogin(creator.id, "google")) return "conflict";
    deps.ensurePersonalUser({ id: creator.id, email: login.email });
    identities.attachLogin(creator.id, { kind: "google", subject: login.subject, email: login.email }, creator.id);
    return { merged: false, identityId: creator.id };
  }

  // Two identities that both hold a Google login would orphan one's personal data in a merge; two that hold none have
  // nothing to merge into. Otherwise the ImpressoRx side always goes into the Google-holding one.
  const creatorHasGoogle = identities.hasLogin(creator.id, "google");
  if (creatorHasGoogle === identities.hasLogin(second.id, "google")) return "conflict";
  const [from, to] = creatorHasGoogle ? [second, creator] : [creator, second];
  identities.mergeInto(from.id, to.id, creator.id);
  return { merged: true, identityId: to.id };
}

/**
 * Finishing a link, for the dashboard's server side (service-token auth, mounted by the caller). The request names the
 * intent and proves the browser with its secret; the identity that opened the intent comes from the intent, never from the request.
 */
export function createIdentityLinkRouter(deps: IdentityLinkDeps): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const body = LinkBodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_request" });
    const { linkIntentId, secret, login } = body.data;

    // Spent first and atomically: whatever happens next, this intent cannot be replayed, so a retry needs a fresh one.
    const creatorId = deps.intents.consume(linkIntentId, secret);
    if (!creatorId) return void res.status(409).json({ error: "link_expired" });

    try {
      const outcome = link(deps, creatorId, login);
      if (outcome === "conflict") return void res.status(409).json(CONFLICT);
      res.json({ linked: true, ...outcome });
    } catch (error) {
      // Someone else attached this login first.
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return void res.status(409).json(CONFLICT);
      // Neither the secret nor the login is logged.
      deps.logger.error("Identity link failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "link_incomplete" });
    }
  });

  return router;
}

/**
 * The person's own link calls (session auth; mount after session auth and requireUser, and not personal-only: a hand-off
 * session starts a link too). Both act only on the session's identity.
 */
export function createIdentitySessionRouter(deps: IdentityLinkDeps): Router {
  const router = Router();

  router.post("/link-intent", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    const { id, secret } = deps.intents.create(identityId);
    // The Google-holding identity is the one that others merge into, so it is the one that waits for a hand-off.
    const next = deps.identities.hasLogin(identityId, "google") ? "handoff" : "google";
    res.set("Cache-Control", "no-store").json({ linkIntentId: id, secret, next });
  });

  router.post("/unlink", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    const body = UnlinkBodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      res.json(deps.identities.unlink(identityId, body.data.loginIdentityId, identityId));
    } catch (error) {
      if (error instanceof UnlinkRefusedError) {
        // A login that is not the caller's looks the same as one that does not exist.
        if (error.reason === "login_not_found") return void res.status(404).json({ error: "login_not_found" });
        return void res.status(409).json({ error: "unlink_refused", reason: error.reason });
      }
      deps.logger.error("Identity unlink failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "unlink_failed" });
    }
  });

  return router;
}
