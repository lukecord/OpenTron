# OpenTRON

*A guardian program for the Grid.*

(Note: This was all just vibe-coded for fun, and I have not thoroughly tested everything. Use at your own risk! The following is written by AI:)

OpenTRON is a transparent proxy and remote kill switch for [OpenClaw](https://github.com/openclaw). It sits silently between your clients and OpenClaw, monitoring all traffic for signs of a corrupted program — and can derez (terminate) OpenClaw instantly when you give the word.

Nothing changes for your existing integrations. Telegram, WhatsApp, Slack, Discord, CLI, web UI — they all keep pointing to the same port. OpenTRON intercepts silently.

---

## Setup — 5 Steps to Enter the Grid

### 1. Install Dependencies

```bash
npm install
```

### 2. Move OpenClaw to Port 18790

Open your OpenClaw config (`~/.openclaw/openclaw.json`) and set:

```json
{
  "gateway": {
    "port": 18790,
    "trustedProxies": ["127.0.0.1"]
  }
}
```

Or set the environment variable before starting OpenClaw:

```bash
export OPENCLAW_GATEWAY_PORT=18790
```

> **Why?** OpenTRON takes over OpenClaw's default port (18789) so all your existing integrations connect through OpenTRON automatically (allegedly). OpenClaw moves to 18790 where only OpenTRON can see it.

### 3. Configure Your Identity Disc

```bash
cp .env.example .env
```

Edit `.env` and fill in the two required values:

| Variable | What It Is |
|---|---|
| `TRON_DISC_KEY` | A secret token for the remote API. Generate one: `openssl rand -hex 32` |
| `OPENCLAW_GATEWAY_TOKEN` | Your OpenClaw gateway token (find it in your OpenClaw dashboard) |

### 4. Activate OpenTRON

```bash
npm start
```

You should see the OpenTRON banner and initialization logs. The Grid is now watching.

### 5. Test the Kill Switch

Send this message from **any** connected client (Telegram, Discord, web UI, etc.):

```
DEREZ
```

Or with the bang prefix:

```
!DEREZ
```

OpenTRON will execute the kill chain and respond:

> **[OpenTRON] Corrupted program derezzed. The Grid is safe.**

---

## Remote DEREZ — From Anywhere

OpenTRON exposes a remote HTTPS API on port 9999. Use it from your phone, another machine, or a one-tap Shortcut:

```bash
# Check Grid status
curl -k https://localhost:9999/status \
  -H "Authorization: Bearer YOUR_TRON_DISC_KEY"

# Trigger full DEREZ
curl -k -X POST https://localhost:9999/derez \
  -H "Authorization: Bearer YOUR_TRON_DISC_KEY"

# Derez a specific process by name
curl -k -X POST https://localhost:9999/derez/node \
  -H "Authorization: Bearer YOUR_TRON_DISC_KEY"
```

> **Note:** The `-k` flag skips TLS verification for the self-signed cert. For production, replace `tron.cert.pem` and `tron.key.pem` with real certificates.

### iOS / Android Shortcut

Create a shortcut that sends a POST request to `https://YOUR_SERVER_IP:9999/derez` with the header `Authorization: Bearer YOUR_TRON_DISC_KEY`. One tap to derez from anywhere.

---

## How OpenTRON Works

```
Clients (Telegram, Discord, etc.)
         │
         ▼
   ┌──────────┐
   │ OpenTRON │  ← Port 18789 (transparent proxy)
   │          │  ← Inspects every message for DEREZ
   └─────┬────┘
         │
         ▼
   ┌──────────┐
   │ OpenClaw │  ← Port 18790 (moved here)
   └──────────┘
```

### The DEREZ Kill Chain

When OpenTRON detects the kill word, it executes a 3-step sequence:

1. **Graceful** — Asks OpenClaw nicely to stop via its API
2. **Force** — If still running after 2 seconds, finds and force-kills the process
3. **Nuclear** — If all else fails, uses OS-level commands to free the port

---

## Configuration Reference

| Variable | Purpose | Default |
|---|---|---|
| `TRON_DISC_KEY` | Bearer token for remote API (Identity Disc) | *required* |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw's token for graceful stop | *required* |
| `TRON_KILL_WORD` | Keyword that triggers DEREZ | `DEREZ` |
| `TRON_PORT` | Port OpenTRON listens on | `18789` |
| `OPENCLAW_PORT` | Port OpenClaw was moved to | `18790` |
| `TRON_API_PORT` | Port for remote REST API | `9999` |

---

## TLS Certificates

On first run, OpenTRON auto-generates a self-signed certificate for the remote API. To use a real certificate:

1. Place your cert at `tron.cert.pem` in the project directory
2. Place your key at `tron.key.pem` in the project directory
3. Restart OpenTRON

---

## Logs — The Grid

All activity is logged to `grid.log` with structured JSON entries. Monitor the Grid:

```bash
# Follow the Grid in real time
tail -f grid.log | npx pino-pretty

# Or on Windows
Get-Content grid.log -Wait
```

---

*OpenTRON fights for the users.*
