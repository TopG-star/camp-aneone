# Environment Setup Guide

## Quick Start

```bash
# 1. Copy the template for your environment
cp .env.template .env              # Production / staging
cp .env.local.template .env.local  # Local development overrides
cp .env.test.local.template .env.test.local  # Test overrides

# 2. Fill in your values
# Open each file in your editor and replace the empty values.
# See sections below for how to generate each secret.

# 3. Never commit .env files
# .gitignore already excludes them, but double-check before pushing.
```

## File Layout

| File | Tracked? | Purpose |
|------|----------|---------|
| `.env.template` | **Yes** | Production template — copy to `.env` |
| `.env.local.template` | **Yes** | Local dev template — copy to `.env.local` |
| `.env.test.local.template` | **Yes** | Test template — copy to `.env.test.local` |
| `.env.example` | **Yes** | Full variable reference with comments |
| `.env` | **No** | Your production/staging secrets |
| `.env.local` | **No** | Your local development secrets |
| `.env.test.local` | **No** | Your test secrets |

## Generating Secrets

### NEXTAUTH_SECRET / API_TOKEN / OAUTH_TOKEN_ENCRYPTION_KEY

```bash
openssl rand -base64 32
```

Each of these must be unique. Never reuse the same value.

### Webhook Secrets (GitHub, Outlook, Teams)

```bash
openssl rand -base64 32
```

Use the same value in the `.env` file and in the webhook provider configuration (GitHub settings, Power Automate flow).

### VAPID Keys (Web Push)

```bash
npx web-push generate-vapid-keys
```

Copy the public and private keys into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

### Google OAuth Credentials

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Web application)
3. Set authorized redirect URI to `http://localhost:3000/api/auth/callback/google` (dev) or your production URL
4. Copy Client ID → `GOOGLE_CLIENT_ID`, Client Secret → `GOOGLE_CLIENT_SECRET`

## Key Rotation

### OAUTH_TOKEN_ENCRYPTION_KEY

**Required in production.** Tokens are encrypted at rest with AES-256-GCM using this key.

To rotate:
1. Generate a new key: `openssl rand -base64 32`
2. Update `.env` with the new key
3. Restart the agent-server
4. Users will need to re-authenticate OAuth integrations (existing encrypted tokens won't decrypt)

### NEXTAUTH_SECRET

Rotating this will invalidate all active sessions. Users will need to sign in again.

### API_TOKEN

Rotating this requires updating any scripts or CI pipelines that use it as a Bearer token.

## Security Rules

1. **Never commit `.env`, `.env.local`, or `.env.test.local`** — they contain real secrets
2. **Only commit templates** (`.env.template`, `.env.local.template`, `.env.test.local.template`, `.env.example`)
3. **Never paste secrets into chat, issues, PRs, or Copilot** — share only template names
4. **Pre-commit hooks** (gitleaks) scan for accidentally staged secrets — don't bypass them
5. **CI secret scanning** (GitHub Actions) catches anything pre-commit misses
