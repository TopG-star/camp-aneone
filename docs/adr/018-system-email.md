# ADR-018: System Email from oneon.app

## Status: Accepted in part (owner decisions, Gerry, 2026-10-17). The setup below is the controller's proposal, for the owner to confirm. Open items are owner decisions. Nothing is built.

## Date: 2026-10-17

## Context

Oneon has its own domain, `oneon.app` (ADR-017, decision 10), and will send email from it.

Today Oneon sends no email of its own. On 2026-10-17 the packages contained no mail library and no sender. The only match was an "SMTP timeout" error string in a test.

This ADR is about Oneon's own system email: messages from Oneon to a person, sent from `oneon.app`. It is not about the roadmap's "Email send" item (roadmap v1.2, open question 7). That item is about sending as the person, through their Gmail or Teams account, with an executor and their permissions. The two never share a sender, a key or a domain.

## Decision (owner)

1. **Provider: Resend**, for transactional email only.
2. **Separation:** authentication and security email stays apart from marketing and bulk announcements. If marketing email is ever sent, it uses:
   - its own sending subdomain, so its reputation cannot harm delivery of sign-in or security email;
   - its own Resend domain, or another provider;
   - its own API key.
3. **Predictable, low-volume and easy to audit.** Oneon's first transactional emails meet all three. The setup below says how.

## Setup (controller proposal, for the owner to confirm)

### DNS and sending domain

- **Sending domain: `mail.oneon.app`**, added in Resend with the EU region (Ireland), the closest to Frankfurt.
  - Mail goes out from an address at `mail.oneon.app`. The bare `oneon.app` sends nothing.
  - The owner added the domain in Resend on 2026-10-17 using Resend's automatic Cloudflare setup, and Resend reports it verified. The records, all DNS-only, were read back from Cloudflare and from public DNS on 2026-10-17:

    | Record | Type | Points to | Purpose |
    |---|---|---|---|
    | `send.mail.oneon.app` | CNAME | `send.forge.rmta.net` | Return path. Resend publishes the SPF record and the bounce MX behind this name. |
    | `rsend.mail.oneon.app` | CNAME | `rsend-euw1.forge.rmta.net` | Resend's EU (Ireland) region endpoint |
    | `resend._domainkey.mail.oneon.app` | TXT | DKIM public key (RSA 1024-bit) | Signing |

  - Because SPF and the MX sit behind Resend's CNAME, Resend can change its sending IPs without a DNS change here. It also means the SPF record is Resend's to change, not Oneon's.
  - The DKIM key is 1024-bit. Receivers accept 1024-bit keys, but 2048-bit is the current recommendation. Whether Resend offers a 2048-bit key is checked in Resend.
- **DMARC on `oneon.app`.** The policy starts at `p=none`, which only reports. Reports go to Cloudflare DMARC Management, so no mailbox is needed.
  - Live since 2026-10-17: `v=DMARC1; p=none; rua=mailto:5e97139f883b4e99ad0e21fa2a968404@dmarc-reports.cloudflare.net`.
  - Cloudflare created the record when DMARC Management was turned on.
  - The record sets no `sp` tag, so `mail.oneon.app` inherits `p=none`.
  - It moves to `quarantine`, then `reject`, once the reports show only Resend sending aligned mail. Each step is the owner's call, made on the reports.
  - The subdomain policy (`sp`) follows the same steps.

### What makes it predictable and auditable (when built)

- **Fixed catalogue.** Each message type is defined in code: a fixed subject, a fixed template, and typed parameters. The sender accepts a type and its parameters, never a free-form subject or body.
  - Mechanism: the send function's type signature, plus a test over the catalogue.
- **One door.** Only the mail module imports the Resend client.
  - Mechanism: an architecture test, like the existing ones in `architecture.test.ts`.
- **Minimal content.** Messages carry no business data and no D2 text. Links point only to the instance's own `*.oneon.app` address.
  - Mechanism: catalogue review, with a test that renders every type and checks its links. Keeping data out of the parameters is a review convention, not a mechanism.
- **Audit row per send.** Each send records:
  - the message type;
  - the recipient's identity id (not the address, where an identity exists);
  - the instance;
  - Resend's message id;
  - the time;
  - the outcome: `sent`, or `failed` with the error.

  "Sent" means Resend accepted the message. It does not mean the message was delivered or read.
- **Volume caps.** The module enforces a per-recipient cap and a global cap per hour. A send over the cap is refused and recorded as `refused_cap`; nothing is queued for later. The limits are set when the catalogue exists. Resend's plan has its own daily limit, which is checked at setup.
- **Failure.** If Resend refuses or times out:
  - the send is recorded as `failed`, retried a bounded number of times, then dropped;
  - whether a failed security email blocks the action it reports is decided per message type in the catalogue.

### Suppliers

Resend becomes a supplier that processes personal data (a subprocessor). It sees each recipient's address and the content of each message. It is listed next to Cloudflare (ADR-017) in the subprocessor list and the privacy notice. No subprocessor list exists in the repository yet.

## Open items (owner decisions, CLAUDE.md section 5 / ADR-016)

1. **Which messages exist (identity).** Any message that carries a sign-in link or code, or one that confirms a link between identities, is an identity decision. The first catalogue goes to the owner before it is built.
2. **The Resend API key (keys).**
   - Proposed: a sending-only key restricted to `mail.oneon.app`, held in Render's secret store (ADR-017, decision 5).
   - Proposed: separate keys for the personal instance, the shared service and staging, so revoking one leaves the others working.
   - Still to decide: whether staging sends real email or uses Resend's test addresses only; and the rotation schedule.
3. **Retention of the send log and of Resend's own logs (deletion).** How long the audit rows are kept, and whether Resend's log retention is acceptable or must be shortened.
4. **Sender and reply address.** For example `noreply@mail.oneon.app`, and whether replies reach a real mailbox.

## Consequences

**Easier:**
- Sign-in and security email has its own domain reputation and its own key from the start.
- Each send leaves an audit row.
- Changing provider later changes one module.

**Harder or accepted:**
- Resend is one more supplier to review and disclose.
- No email can be sent until the catalogue and the key decisions are made.
- DMARC is not enforcing at first. Until it reaches `quarantine`, receivers are only asked to report on mail that fails the checks, not to block it.
