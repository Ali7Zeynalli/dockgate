# FAQ

**What is DockGate?**
A self-hosted control panel for Docker, Docker Compose and Docker Swarm, and for the servers they run on. One panel manages the host it runs on and any number of servers over SSH.

**Is it free?**
Yes. It is open source under the MIT license.

**What do my servers need?**
SSH access and a user with passwordless `sudo` for setup. Docker can be installed by DockGate (**Server Console → Setup**). Nothing else runs on them unless you install the optional Edge agent.

**Which systems are supported?**
Ubuntu and Debian are the main targets; RHEL-type systems (Rocky, Alma) work too, with firewalld instead of UFW. DockGate itself runs anywhere Docker runs.

**Does DockGate change my existing containers or Compose files?**
No. It shows what is already there, including stacks started with `docker compose up` (*external*). It writes files only for stacks you deploy through it. **Move to Swarm** stops a Compose project but never edits its compose files.

**Can several people use it?**
There is one admin account. Share access carefully: whoever signs in can control Docker on every server.

**Can I put it on the internet?**
Keep port 7077 off the internet. The Docker socket gives root on the host. Use a VPN (WireGuard, NovusGate) or an SSH tunnel. If you must expose it, put it behind HTTPS and set `COOKIE_SECURE=true` and `TRUST_PROXY`.

**Where is my data?**
DockGate's own data (settings, logins, history) is in its data folder (`./data`). Your apps' data is in Docker volumes on each server. See [Getting started → Back up](getting-started.md).

**How do I update DockGate?**
**Settings → Software update → Update to vX Now**, or pull the new image and recreate the container. Your data stays.

**Do I need Swarm?**
No. Compose on one server is enough for many setups. Swarm adds replicas, rolling updates with automatic roll back, secrets, autoscaling and more servers. It works on a single server too, and a Compose project can be moved to Swarm and back at any time.

**Does Swarm scale by itself?**
No, Swarm keeps the number of replicas you set. DockGate's [Auto Scaling](swarm-auto-scaling.md) adds and removes replicas by CPU and memory.

**Does DockGate add servers when the cluster is full?**
No. It tells you when a replica does not fit; adding a server is your call (**Swarm → Nodes → Add servers…**).

**What is the Edge agent, and do I need it?**
A small container on each server that sends metrics, logs and alerts outward. Optional: without it DockGate reads everything over SSH. Install it when you want alerts while DockGate is offline, or when servers are behind NAT.

**Are my passwords safe?**
The admin password is hashed (scrypt). SSH logins, registry passwords, channel tokens, the Swarm unlock key and stack variables are encrypted (AES-256-GCM) with a key kept in the data folder or `DG_MASTER_KEY`. Swarm secrets are sent to Swarm only and never stored by DockGate.

**Is anything sent to the internet?**
Only what you use: image pulls, Git, the template list, update checks on GitHub, and your notification channels.

**Where do I report a bug or ask for a feature?**
On GitHub, under *Issues*. Include the steps and the message you see, without passwords or addresses.
