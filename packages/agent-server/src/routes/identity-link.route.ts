import { Router } from "express";
import { z } from "zod";
import type { LinkedLoginsView } from "@oneon/contracts";
import type { Logger } from "@oneon/domain";
import {
  LinkUnavailableError,
  UnlinkRefusedError,
  type Identity,
  type IdentityRepository,
  type LinkIntentRepository,
  type TenantRegistrationRepository,
} from "@oneon/infrastructure";

export interface IdentityLinkDeps {
  identities: Pick<
    IdentityRepository,
    | "findByLogin"
    | "findById"
    | "hasLogin"
    | "attachGoogleSubByEmailOnce"
    | "attachLogin"
    | "mergeInto"
    | "unlink"
    | "listMemberships"
    | "registrationsOf"
    | "googleEmailOf"
    | "listLogins"
  >;
  intents: Pick<LinkIntentRepository, "create" | "peek" | "consume">;
  registrations: Pick<TenantRegistrationRepository, "findById">;
  /** Makes sure the identity has a row in the personal database, whose foreign keys point at users(id). */
  ensurePersonalUser: (user: { id: string; email: string }) => void;
  /** True while this session holds a usable attended grant opened for exactly this identity and membership. */
  hasAttendedGrant: (sessionId: string, identityId: string, membershipId: string) => boolean;
  /**
   * After a control transaction revoked grants in SQL: forget their cached tokens and revoke them at ImpressoRx. Best effort;
   * it is not awaited and its failure never reaches the person.
   */
  releaseGrants: (grantIds: string[]) => Promise<void>;
  logger: Logger;
}

/**
 * The second sign-in, as the dashboard's server side reports it. A Google login is identified by Google's `sub`. A hand-off
 * has no subject the dashboard knows: it signed in as an identity the agent-server itself created, so it names that, with the
 * session and membership from its sealed session so the server can check them (the service token alone proves nothing about
 * who signed in).
 */
const LoginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("google"),
    subject: z.string().min(1).max(256),
    email: z.string().min(3).max(320).transform((email) => email.toLowerCase()),
  }),
  z.object({
    kind: z.literal("impressorx"),
    identityId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    membershipId: z.string().min(1).max(64),
  }),
]);
type Login = z.infer<typeof LoginSchema>;

// An empty secret is a request without the browser's secret: refused as link_expired like any other, not as malformed.
const LinkBodySchema = z.object({
  linkIntentId: z.string().max(64),
  secret: z.string().max(256),
  login: LoginSchema,
});

const UnlinkBodySchema = z.object({ loginIdentityId: z.string().min(1).max(64) });

type Refusal = "link_expired" | "link_conflict" | "link_needs_google" | "link_account_disabled" | "link_unavailable";

/** `googleEmail` is null when the Google login has none on record: the caller words that, nothing is invented here. */
type Summary = { googleEmail: string | null; memberships: Array<{ role: string; pharmacyName: string }> };

/** What a link would do, decided without changing anything. */
type Plan =
  | { ok: false; error: Refusal }
  | {
      ok: true;
      creator: Identity;
      action: { kind: "none" } | { kind: "attach"; email: string; subject: string } | { kind: "merge"; from: Identity; to: Identity };
      summary: Summary;
    };

const refuse = (error: Refusal): Plan => ({ ok: false, error });

const paused = (registrations: Array<{ status: string }>) => registrations.some((r) => r.status !== "active" && r.status !== "removed");

/**
 * Decides what the second login means for the identity that opened the intent. Linking is only ever what the person just
 * did in this browser: two logins that merely share an email are never joined. The preview and the commit both use it, so
 * the person is shown exactly what would be done.
 */
function plan(deps: IdentityLinkDeps, creatorId: string, login: Login): Plan {
  const { identities } = deps;
  // A hand-off is proved by the server's own record of the session, not by what the caller says.
  if (login.kind === "impressorx" && !deps.hasAttendedGrant(login.sessionId, login.identityId, login.membershipId)) return refuse("link_expired");

  const second =
    login.kind === "google"
      ? // The one-time pre-upgrade step (spec §4.2) may be what first meets this Google login; it is not a link.
        (identities.findByLogin("google", login.subject) ?? identities.attachGoogleSubByEmailOnce(login.email, login.subject))
      : identities.hasLogin(login.identityId, "impressorx")
        ? identities.findById(login.identityId)
        : null;
  const creator = identities.findById(creatorId);
  if (!creator || (login.kind === "impressorx" && !second)) return refuse("link_expired");
  if (creator.status !== "active" || (second && second.status !== "active")) return refuse("link_account_disabled");

  const summaryOf = (impressorxSide: Identity, googleEmail: string | null): Summary => ({
    googleEmail,
    memberships: identities.listMemberships(impressorxSide.id).map((m) => ({
      role: m.role,
      pharmacyName: deps.registrations.findById(m.tenantRegistrationId)?.displayName ?? "a pharmacy",
    })),
  });

  if (second?.id === creator.id) {
    const email = login.kind === "google" ? login.email : identities.googleEmailOf(creator.id);
    return { ok: true, creator, action: { kind: "none" }, summary: summaryOf(creator, email) };
  }

  if (!second) {
    // Nobody holds this Google login yet: it joins the current identity. (A hand-off's identity exists before its sign-in
    // reaches us, so only a Google login can be new here.) One identity does not hold two Google logins.
    if (login.kind !== "google") return refuse("link_expired");
    if (identities.hasLogin(creator.id, "google")) return refuse("link_conflict");
    return { ok: true, creator, action: { kind: "attach", email: login.email, subject: login.subject }, summary: summaryOf(creator, login.email) };
  }

  // Two identities that both hold a Google login would orphan one's personal data in a merge; two that hold none have
  // nothing to merge into. Otherwise the ImpressoRx side always goes into the Google-holding one.
  const creatorHasGoogle = identities.hasLogin(creator.id, "google");
  const secondHasGoogle = identities.hasLogin(second.id, "google");
  if (creatorHasGoogle && secondHasGoogle) return refuse("link_conflict");
  if (!creatorHasGoogle && !secondHasGoogle) return refuse("link_needs_google");
  const [from, to] = creatorHasGoogle ? [second, creator] : [creator, second];
  // A paused pharmacy cannot have its file updated, and its rows must not be left behind: try again when it is back.
  if (paused(identities.registrationsOf(from.id))) return refuse("link_unavailable");
  const googleEmail = login.kind === "google" ? login.email : identities.googleEmailOf(to.id);
  return { ok: true, creator, action: { kind: "merge", from, to }, summary: summaryOf(from, googleEmail) };
}

/** Releases revoked grants in the background: the link has committed, and a slow or dead ImpressoRx must not hold up or fail it. */
function release(deps: IdentityLinkDeps, grantIds: string[]): void {
  if (grantIds.length === 0) return;
  const warn = (error: unknown) => deps.logger.warn("Releasing revoked grants failed", { error: error instanceof Error ? error.name : "unknown" });
  try {
    deps.releaseGrants(grantIds).catch(warn);
  } catch (error) {
    warn(error);
  }
}

/**
 * Previewing and finishing a link, for the dashboard's server side (service-token auth, mounted by the caller). The request
 * names the intent and proves the browser with its secret; the identity that opened the intent comes from the intent, never
 * from the request.
 */
export function createIdentityLinkRouter(deps: IdentityLinkDeps): Router {
  const router = Router();

  // Read-only: validates the intent as the commit would, spends nothing and changes nothing.
  router.post("/preview", (req, res) => {
    const body = LinkBodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_request" });
    const creatorId = deps.intents.peek(body.data.linkIntentId, body.data.secret);
    if (!creatorId) return void res.status(409).json({ error: "link_expired" });
    const decided = plan(deps, creatorId, body.data.login);
    if (!decided.ok) return void res.status(409).json({ error: decided.error });
    res.json(decided.summary);
  });

  router.post("/", (req, res) => {
    const body = LinkBodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_request" });
    const { linkIntentId, secret, login } = body.data;

    // A refusal leaves the intent unspent. Once the link is decided the intent is spent first and atomically: from there
    // on, whatever happens, it cannot be replayed, so a retry needs a fresh one.
    const creatorId = deps.intents.peek(linkIntentId, secret);
    if (!creatorId) return void res.status(409).json({ error: "link_expired" });
    const decided = plan(deps, creatorId, login);
    if (!decided.ok) return void res.status(409).json({ error: decided.error });
    if (deps.intents.consume(linkIntentId, secret) === null) return void res.status(409).json({ error: "link_expired" });

    try {
      const { action, creator } = decided;
      if (action.kind === "attach") {
        deps.ensurePersonalUser({ id: creator.id, email: action.email });
        deps.identities.attachLogin(creator.id, { kind: "google", subject: action.subject, email: action.email }, creator.id);
        return void res.json({ linked: true, merged: false, identityId: creator.id });
      }
      if (action.kind === "merge") {
        const { revokedGrantIds } = deps.identities.mergeInto(action.from.id, action.to.id, creator.id);
        release(deps, revokedGrantIds);
        return void res.json({ linked: true, merged: true, identityId: action.to.id });
      }
      // Nothing to do: the two logins already belong to one account. The caller must not tell the person it linked them.
      res.json({ linked: true, merged: false, alreadyLinked: true, identityId: creator.id });
    } catch (error) {
      if (error instanceof LinkUnavailableError) return void res.status(409).json({ error: "link_unavailable" });
      // Neither the secret nor the login is logged.
      deps.logger.error("Identity link failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "link_incomplete" });
    }
  });

  return router;
}

/**
 * The person's own link calls (session auth; mount after session auth and requireUser, and not personal-only: a hand-off
 * session starts a link too). All act only on the session's identity.
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

  // Settings → Connections lists these, so a person can see what is linked and unlink a pharmacy login. A label names the Google
  // email or the pharmacy; the staff user inside an ImpressoRx login's subject never leaves the server.
  router.get("/logins", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    const body: LinkedLoginsView = {
      logins: deps.identities.listLogins(identityId).map((login) => ({
        id: login.id,
        kind: login.kind,
        label:
          login.kind === "google"
            ? (login.email ?? "Google account")
            : `pharmacy staff login at ${(login.registrationId && deps.registrations.findById(login.registrationId)?.displayName) || "a pharmacy"}`,
      })),
    };
    res.json(body);
  });

  router.post("/unlink", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    const body = UnlinkBodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      const { identityId: detachedId, revokedGrantIds } = deps.identities.unlink(identityId, body.data.loginIdentityId, identityId);
      release(deps, revokedGrantIds);
      res.json({ identityId: detachedId });
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
