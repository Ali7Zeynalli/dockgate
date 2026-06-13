# DockGate Notifier Agent

A tiny, **outbound-only** Docker event watcher that DockGate deploys onto each managed
server. It mounts that host's `/var/run/docker.sock` **read-only**, watches the local
Docker events, and sends alerts **directly** to Telegram and/or SMTP — the same channels
you configured in DockGate.

It is a faithful port of DockGate's own notification engine
(`server/notifications/event-monitor.js` + `templates.js` + `telegram.js` + `mailer.js`)
with the database dependency removed: **all config comes from container ENV** injected at
deploy time.

## Why an agent (vs. DockGate's central SSH monitor)

- **Works behind NAT / firewalls** — DockGate never needs an inbound path to the host.
- **Survives DockGate being offline** — alerts keep flowing during panel restarts/maintenance.
- **No inbound surface** — the only listener is a loopback `127.0.0.1` health endpoint for the
  Docker `HEALTHCHECK`; nothing is published. All egress is agent-initiated (HTTPS → Telegram,
  SMTP → your mail host).

> When this agent is installed on a host, DockGate stops its own central `EventMonitor` for
> that host (so you never get duplicate alerts). Removing the agent restarts it.
> **One or the other per host — never both.**

## What it watches

Same classification as the panel: container **die** (split into OOM `137` / Crashed /
Stopped), **restart**, **health_status: unhealthy** (event + 60s sweep), and a 5-minute
**Docker disk-usage** sweep. Each event obeys the per-rule `enabled` flag + cooldown.

## ENV contract

| Key | Default | Notes |
|---|---|---|
| `TG_TOKEN` / `TG_CHAT_ID` | — | Telegram channel (needs both). |
| `SMTP_HOST` | — | SMTP channel (needs HOST+PORT+FROM+TO). |
| `SMTP_PORT` | `587` | `secure` auto-on at `465`. |
| `SMTP_FROM` / `SMTP_TO` | — | Sender / recipient. |
| `SMTP_USER` / `SMTP_PASS` | — | Auth set only when both present. |
| `SERVER_LABEL` | `server` | Host name shown on every alert. |
| `TIMEZONE` | `auto` | IANA tz for timestamps. |
| `DISK_THRESHOLD_GB` | `50` | Absolute GB of Docker reclaimable space. |
| `RULES_JSON` | 6 defaults | `{event_type:{enabled,cooldown_minutes}}` merged over defaults. |
| `DISK_POLL_MIN` / `HEALTH_POLL_SEC` / `RECONNECT_SEC` | `5` / `60` / `5` | Poll/reconnect cadence. |
| `SEND_TEST_ON_START` | — | `true` → send a hello on boot. |
| `AGENT_HEALTH_PORT` | `9000` | Loopback health port (never published). |

At least one channel must be configured or the agent exits with a clear error.

## How DockGate runs it (deploy spec)

```
docker run -d --name dockgate-notifier \
  --restart unless-stopped --memory 96m --cpus 0.25 \
  --security-opt no-new-privileges \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e TG_TOKEN=… -e TG_CHAT_ID=… -e SERVER_LABEL=… [-e SMTP_*=…] \
  dockgate/notifier-agent:1.0.0
```

No `-p` / published ports — outbound-only.

## Security posture

- Runs as **root** inside the container — required to read the host Docker socket (owned
  `root:docker`, mode 660); a non-root user hits `EACCES` unless the host's docker GID is injected
  (it varies per host). Hardened with `--security-opt no-new-privileges`, memory/cpu caps and
  **no published ports**.
- Docker socket mounted **read-only** as defense-in-depth. Honest caveat: a read-only socket mount
  does **not** fully prevent Docker API write calls and still exposes substantial host info — it is
  not a boundary against a compromised image. Pin the image by digest and use a dedicated alert bot /
  send-only SMTP credential; a socket-proxy sidecar is the real hardening.
- Channel secrets are passed as container env, so they are readable via `docker inspect` on
  that host. Use a separate alert-only Telegram bot (revocable via BotFather) and a send-only
  SMTP credential.

## Versioning

Independent semver (`dockgate/notifier-agent:<ver>`) so panel version bumps don't force a
fleet redeploy.

---

Author: **Ali Zeynalli** · part of [DockGate](https://github.com/Ali7Zeynalli/dockgate).
