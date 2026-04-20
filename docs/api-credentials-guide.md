# External API Credentials — Step-by-Step Setup Guide

> Complete this guide **before** Phase 1. Each section produces one or more values that go
> into your `.env` file. Mark each section ✅ as you complete it.

---

## Table of Contents

1. [Google Cloud Project (Gmail + Calendar + OAuth)](#1-google-cloud-project)
2. [Anthropic API Key](#2-anthropic-api-key)
3. [GitHub Personal Access Token + Webhooks](#3-github-personal-access-token--webhooks)
4. [Power Automate — Outlook Bridge](#4-power-automate--outlook-bridge)
5. [Power Automate — Teams Bridge](#5-power-automate--teams-bridge)
6. [Cloudflare Tunnel](#6-cloudflare-tunnel)
7. [VAPID Keys (Web Push)](#7-vapid-keys-web-push)

---

## 1. Google Cloud Project

This single project provides: Gmail API, Google Calendar API, and Google OAuth 2.0 (for
NextAuth sign-in).

### 1.1 Create the project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** → **New Project**
3. Name: `camp-aneone` (or any name you prefer)
4. Click **Create**, then select the new project

### 1.2 Enable APIs

1. Navigate to **APIs & Services → Library**
2. Search for and enable each:
   - **Gmail API**
   - **Google Calendar API**
3. Wait for each to show "API enabled"

### 1.3 Configure OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**
2. User type: **External** (you can restrict to your own account later)
3. Fill in:
   - App name: `camp-aneone`
   - User support email: your Gmail address
   - Developer contact: your Gmail address
4. Click **Save and Continue**
5. **Scopes:** Add the following scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `openid`
   - `email`
   - `profile`
6. Click **Save and Continue**
7. **Test users:** Add your own Gmail address
8. Click **Save and Continue** → **Back to Dashboard**

### 1.4 Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `camp-aneone-web`
5. **Authorized JavaScript origins:**
   - `http://localhost:3000` (development)
   - `https://oneon.yourdomain.com` (production — after Cloudflare Tunnel setup)
6. **Authorized redirect URIs:**
   - `http://localhost:3000/api/auth/callback/google` (development)
   - `https://oneon.yourdomain.com/api/auth/callback/google` (production)
7. Click **Create**
8. **Copy and save:**

```
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

### 1.5 Create a service account (for server-side Gmail polling)

> The OAuth client above is for user login. For server-side Gmail/Calendar access, we use
> a service account OR the user's refresh token. For MVP1 (single user), we use the OAuth
> refresh token obtained during first login. No service account needed.

**Alternative approach (refresh token):**
- When the user first signs in via NextAuth, the refresh token is stored in the database
- The agent-server uses this refresh token to access Gmail and Calendar on behalf of the user
- This is simpler for single-user and avoids domain-wide delegation setup

### Env vars produced

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# The refresh token is obtained automatically during first OAuth sign-in
```

---

## 2. Anthropic API Key

### 2.1 Create account and get key

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Navigate to **API Keys** (left sidebar)
4. Click **Create Key**
5. Name: `camp-aneone`
6. Copy the key immediately (it won't be shown again)

### 2.2 Add credits

1. Go to **Billing** → **Add payment method**
2. Add a credit card
3. Add credits: $10 is sufficient for months of MVP1 usage
   - Haiku 3.5: ~$0.25 per 1M input tokens, ~$1.25 per 1M output tokens
   - Sonnet 4: ~$3 per 1M input tokens, ~$15 per 1M output tokens
   - Estimated daily cost for single user: $0.05-0.15

### Env vars produced

```env
ANTHROPIC_API_KEY=sk-ant-...
LLM_CLASSIFIER_MODEL=claude-3-5-haiku-20241022
LLM_SYNTHESIS_MODEL=claude-sonnet-4-20250514
```

---

## 3. GitHub Personal Access Token + Webhooks

### 3.1 Create a fine-grained Personal Access Token

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Name: `camp-aneone`
4. Expiration: 90 days (set a calendar reminder to rotate)
5. **Repository access:** Select **All repositories** (or select specific repos)
6. **Permissions:**
   - **Repository permissions:**
     - Issues: Read-only
     - Pull requests: Read-only
     - Contents: Read-only
     - Metadata: Read-only (always granted)
   - **Account permissions:** None needed
7. Click **Generate token**
8. Copy the token immediately

### 3.2 Set up webhooks (per repository or organization)

1. Go to the repository → **Settings → Webhooks → Add webhook**
2. Payload URL: `https://oneon.yourdomain.com/api/webhooks/github`
   (use a temporary URL from [webhook.site](https://webhook.site) for testing)
3. Content type: `application/json`
4. Secret: Generate a random secret:
   ```powershell
   [System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
   ```
5. Events: Select **Let me select individual events**, then check:
   - **Issues** (opened, closed, assigned)
   - **Pull requests** (opened, closed, review requested)
   - **Issue comments**
   - **Push** (optional — for monitoring commits)
6. Click **Add webhook**
7. Repeat for each repository you want to monitor

### Env vars produced

```env
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=<your-random-secret>
```

---

## 4. Power Automate — Outlook Bridge

### 4.1 Create the flow

1. Go to [Power Automate](https://make.powerautomate.com/)
2. Click **+ Create → Automated cloud flow**
3. Flow name: `camp-aneone-outlook-ingest`
4. Trigger: **When a new email arrives (V3)** (Office 365 Outlook)
5. Configure trigger:
   - Folder: Inbox
   - Include attachments: No
   - Only with attachments: No

### 4.2 Add HTTP action

1. Click **+ New step → HTTP**
2. Method: **POST**
3. URI: `https://oneon.yourdomain.com/api/webhooks/power-automate`
4. Headers:
   ```
   Content-Type: application/json
   Authorization: Bearer <your-shared-secret>
   ```
5. Body (use dynamic content):
   ```json
   {
     "source": "outlook",
     "messageId": "@{triggerOutputs()?['body/id']}",
     "from": "@{triggerOutputs()?['body/from']}",
     "subject": "@{triggerOutputs()?['body/subject']}",
     "bodyPreview": "@{triggerOutputs()?['body/bodyPreview']}",
     "receivedAt": "@{triggerOutputs()?['body/receivedDateTime']}",
     "importance": "@{triggerOutputs()?['body/importance']}"
   }
   ```

### 4.3 Generate the shared secret

```powershell
[System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
```

Use this value in both the Power Automate flow header and your `.env` file.

### 4.4 Test the flow

1. Send yourself a test email
2. Check flow run history in Power Automate
3. Verify the webhook receives the payload (use webhook.site initially)

### Env vars produced

```env
PA_OUTLOOK_WEBHOOK_SECRET=<your-shared-secret>
```

---

## 5. Power Automate — Teams Bridge

### 5.1 Create the flow

1. Go to [Power Automate](https://make.powerautomate.com/)
2. Click **+ Create → Automated cloud flow**
3. Flow name: `camp-aneone-teams-ingest`
4. Trigger: **When a new message is posted in a channel** (Microsoft Teams)
   - OR **When I am @mentioned in a channel message** (if you only want mentions)
5. Configure trigger:
   - Team: Select your team
   - Channel: Select the channel (or "Any channel")

### 5.2 Add HTTP action

1. Click **+ New step → HTTP**
2. Method: **POST**
3. URI: `https://oneon.yourdomain.com/api/webhooks/power-automate`
4. Headers:
   ```
   Content-Type: application/json
   Authorization: Bearer <your-shared-secret>
   ```
5. Body:
   ```json
   {
     "source": "teams",
     "messageId": "@{triggerOutputs()?['body/id']}",
     "from": "@{triggerOutputs()?['body/from/user/displayName']}",
     "channel": "@{triggerOutputs()?['body/channelIdentity/channelName']}",
     "body": "@{triggerOutputs()?['body/body/content']}",
     "receivedAt": "@{triggerOutputs()?['body/createdDateTime']}"
   }
   ```

### 5.3 Use a different secret than Outlook (defense in depth)

```powershell
[System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
```

### Env vars produced

```env
PA_TEAMS_WEBHOOK_SECRET=<your-shared-secret>
```

---

## 6. Cloudflare Tunnel

### 6.1 Prerequisites

- A domain managed by Cloudflare (free plan is fine)
- If you don't have one, buy a domain via Cloudflare Registrar (~$10/year for `.dev`)

### 6.2 Install cloudflared

**On the deployment VM (Ubuntu):**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

**On Windows (for local testing):**
```powershell
winget install Cloudflare.cloudflared
```

### 6.3 Authenticate

```bash
cloudflared tunnel login
```
This opens a browser. Select your domain and authorize.

### 6.4 Create the tunnel

```bash
cloudflared tunnel create oneon
```

This creates a tunnel and outputs a **Tunnel ID** and a credentials file at
`~/.cloudflared/<tunnel-id>.json`.

### 6.5 Configure DNS

```bash
cloudflared tunnel route dns oneon oneon.yourdomain.com
```

This creates a CNAME record pointing `oneon.yourdomain.com` to the tunnel.

### 6.6 Create config file

Create `~/.cloudflared/config.yml`:
```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: oneon.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### 6.7 Run as a service

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

### Env vars produced

```env
CLOUDFLARE_TUNNEL_TOKEN=<tunnel-token>
PUBLIC_URL=https://oneon.yourdomain.com
```

---

## 7. VAPID Keys (Web Push)

> For MVP1, web push is behind a feature flag (`FEATURE_PUSH_NOTIFICATIONS=false`).
> Generate keys now so they're ready when you enable push.

### 7.1 Generate keys

```powershell
npx web-push generate-vapid-keys
```

Output will look like:
```
Public Key:  BNx...
Private Key: abc...
```

### 7.2 Set a contact email

The VAPID subject must be a `mailto:` URL or an HTTPS URL.

### Env vars produced

```env
VAPID_PUBLIC_KEY=BNx...
VAPID_PRIVATE_KEY=abc...
VAPID_SUBJECT=mailto:your-email@gmail.com
```

---

## Checklist

| Service            | Env Vars                                          | Status |
|--------------------|---------------------------------------------------|--------|
| Google OAuth       | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`        | ☐      |
| Anthropic          | `ANTHROPIC_API_KEY`                                | ☐      |
| GitHub             | `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`            | ☐      |
| Power Automate (OL)| `PA_OUTLOOK_WEBHOOK_SECRET`                       | ☐      |
| Power Automate (TM)| `PA_TEAMS_WEBHOOK_SECRET`                         | ☐      |
| Cloudflare Tunnel  | `CLOUDFLARE_TUNNEL_TOKEN`, `PUBLIC_URL`            | ☐      |
| VAPID Keys         | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | ☐ |

> **Security reminder:** Never commit secrets to git. All values go in `.env` (which is
> in `.gitignore`). For production, use the VM's environment or Docker secrets.
