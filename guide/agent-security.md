# Edge agent → How DockGate commands it, safely

> **Where:** **Servers → Edge agent** (install or update), and **Deploy → Compose stacks → ⋯ → Scaling & health…** (the rules it runs).

Besides watching, the Edge agent keeps the **Scaling & health** rules of a server: it brings back replicas that are gone and restarts containers that stay unhealthy — also while DockGate is offline. This page is how it is told what to do, and why nobody else can tell it.

## No port, one key

| | |
|---|---|
| **No network port** | The agent listens on a unix socket inside its own container (`/run/dockgate-agent/cmd.sock`, owner only). Nothing on the network reaches it; DockGate hands a message in with `docker exec` — locally, or over the server's SSH connection. Only someone who is already root on the server could reach the socket |
| **One key per install** | When DockGate installs or updates an agent, it makes an Ed25519 key pair for that server. The private key stays in DockGate, encrypted like every other secret; the agent gets only the public key |
| **Every message is signed** | Rules and commands carry the server's id, a number that only grows, and the time. The agent checks the signature, that the message is for this server, that the number is higher than the last one (a copied message can not be sent again), and that a command is under 10 minutes old (rules: 7 days) |
| **A short list of actions** | Even a correctly signed message can only: restart a replica of a service it has a rule for, add or remove one replica within the rule's limits (never above 20), reload nginx / Caddy, or read its state. No shell, no `docker run`, no pulling images, no files |
| **Limits checked again** | The agent checks the limits itself, so a mistake — or a stolen DockGate — can not go past them |

A message that fails a check is refused and written to the agent's history; you get a notice (at most one every 10 minutes): *Rejected a command — it was not signed by the DockGate that installed this agent.*

## Who runs the rules

One side at a time, so nothing is done twice:

- **The agent**, once it has taken the latest rules and answered in the last 12 minutes. The panel says *The agent on this server runs these rules (rules vN)*.
- **DockGate**, otherwise (no agent, an old agent, or it did not answer). The panel says so, and the reason.

DockGate sends the rules whenever you change them in the panel, right after an install or update, and every 10 minutes.

## What the agent does with them

| Rule | What it does |
|---|---|
| **Replicas** | Every 30 s it counts the replicas of each service. If some are gone (two checks in a row, and no deploy in the last 2 minutes), it starts new ones the way Compose does — same config, limits, networks and names — and reloads the proxies. It only does this while the running replicas were started with DockGate's override; otherwise it is drift, and the panel shows it |
| **Auto-heal** | A container whose own health check says *unhealthy* — or, without a health check, whose port does not answer — is restarted after 3 failed checks in a row, not in its first 60 s. After 3 restarts in an hour it stops trying and tells you to look at the logs |

The port check runs from a tiny helper container that shares the checked container's network, read-only and without privileges; it is removed right after.

## Good to know

- Reinstalling the agent, or installing it from another DockGate, makes a new key: the old one stops working at once.
- The agent keeps its rules in its own container, so a restart keeps them; DockGate sends them again within seconds of an install.
- A DockGate restored from an older backup still commands its agents: the message numbers never fall below the clock.

## Errors and fixes

| You see | Why | What to do |
|---|---|---|
| *DockGate runs these rules — the agent has not taken the latest ones yet* | The agent is older than this DockGate, stopped, or did not answer | **Servers → Edge agent → Update** |
| `The agent did not answer (is the dockgate-agent container running, and up to date?)` | No agent container, or an old one without the control channel | Install or update the agent |
| `This agent has no key yet — update the agent` | The agent was installed by an older DockGate | Update it once |
| Agent history: `rejected (signature)` | A message not signed by this DockGate's key | Nothing to do if it was not you; if it keeps coming, someone with root on the server is trying |
| Agent history: `rejected (replay)` / `(stale)` | An old message sent again, or a clock far off | Check the server's clock (**Server Console → Setup → Time sync**) |
