# Troubleshooting

The most common problems, what they mean and what to do. Each page of these docs also ends with its own **Errors and fixes** table.

## Signing in

| You see | Why | What to do |
|---|---|---|
| `Too many attempts — try again later` | Too many wrong passwords from your address | Wait a few minutes |
| The setup page asks for a **setup token** | First setup from the internet | Find the token in DockGate's log (`docker logs dockgate-control-panel`), or set `DG_SETUP_TOKEN` yourself |
| Signed out often | Another browser changed the password or used **Sign out everywhere** | Sign in again |
| Forgot the password | — | [Getting started → Forgot password](getting-started.md) |

## DockGate itself

| You see | Why | What to do |
|---|---|---|
| The page does not load | DockGate is not running, or the port is blocked | `docker ps` on the host; `docker logs dockgate-control-panel`; check the port (7077) |
| *Disconnected* in the top bar | The live connection (WebSocket) dropped | It reconnects by itself. Behind a proxy, allow WebSockets |
| `permission denied … /var/run/docker.sock` | The socket is not mounted, or not readable | Mount `/var/run/docker.sock` into the DockGate container (see `docker-compose.yml`) |
| Wrong client IP in the audit log behind a proxy | The proxy is not trusted | Set `TRUST_PROXY` |
| Cookies not kept over HTTPS | The cookie is not marked secure | Set `COOKIE_SECURE=true` behind HTTPS |

## Remote servers

| You see | Why | What to do |
|---|---|---|
| `Could not reach the server` / timeout | Wrong address or port, the server is down, or a firewall blocks SSH from DockGate | Check `ssh user@host -p port` from DockGate's host |
| `All configured authentication methods failed` | Wrong user, key or password | Check the login in **Server Console → Settings** |
| `Host key mismatch — …` | The server's SSH key changed | After a rebuild: **Server Console → Access & SSH → Re-trust…**. Otherwise do not connect |
| `SSH OK — Docker not detected` | Docker missing, or the user can not use it | **Server Console → Setup**, or **Settings → Docker access → Grant…** |
| `sudo: a password is required` | The user has no passwordless `sudo` | Use the deploy user (**Setup**) |
| Pages are slow on one server | Every reading goes over SSH | Install the [Edge agent](servers.md#edge-agent) |

## Containers and deploys

| You see | Why | What to do |
|---|---|---|
| `port is already allocated` / `address already in use` | Another container or program uses the host port | Change the host port, or stop the other one (**Dashboard → Port Map** shows who has it) |
| A container restarts again and again | The app exits on start | Open its **Logs**; check environment variables and volumes |
| `OOMKilled` | Out of memory | Raise the memory limit, or find the leak |
| `pull access denied` / `unauthorized` | Private image without a login | Add the login in **Deploy → Registries** |
| `manifest unknown` / `not found` | The tag does not exist | Check the tag on the registry |
| `no space left on device` | The disk is full | **Resources → Prune**; set log limits (**Server Console → Setup → Docker log limits**) |
| Compose: `Invalid compose file: …` | YAML error | Fix the line in the message |
| Git deploy: `Not a fast-forward …` | Files changed on the server | **Force pull…** |

## Swarm

| You see | Why | What to do |
|---|---|---|
| Task: `no suitable node (insufficient resources on N node)` | No server has the reserved CPU or memory free | Lower the reservation or replicas, or add a server |
| Task pending: `no suitable node (… constraint …)` | No server matches the placement constraints | Fix the constraint or a node's labels |
| `The server in use is a worker — switch to a manager at the top` | A worker is picked | Pick a manager in **SERVERS ▾** |
| **Swarm is locked** | Autolock and a Docker restart | **Unlock…** on Swarm → Overview |
| **Most managers can not be reached** | Quorum lost | Wait for them, or **Recover cluster…** ([Cluster settings](swarm-cluster.md)) |
| Data gone after a task moved | Named volumes live on one server | Pin the service to one server, or use shared storage |
| An update is *paused* | A new task failed | Fix the cause, then **Resume the update…** or **Roll back** |

## Notifications

| You see | Why | What to do |
|---|---|---|
| No alerts arrive | No channel set up, the rule is off, or the server is muted | **Settings → Notifications**: set a channel, press **Test**, check the rule and **Muted servers** |
| *failed* in **Notifications sent** | The channel refused the message | Read the error there and fix the channel |
| Alerts twice | Agent and DockGate both watching | The agent pauses DockGate's own monitor for its server; update the agent |

Still stuck? Open an issue on GitHub with the message you see and the steps that lead to it. Remove passwords, tokens and addresses first.
