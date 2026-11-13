# Deploy → Compose stacks → Scaling & health

> **Where:** **Deploy → Compose stacks →** a stack's **⋯ → Scaling & health…**
>
> **Works on:** the server picked in the top bar (**SERVERS ▾**). No Swarm needed.

Run a Compose service as several containers (replicas) with one click. Docker spreads the requests over them by the service's name, so a proxy in front (nginx, Caddy) or another service reaches all of them as `http://api:8080`.

![Scaling & health](images/compose-scaling.png)

| Column | What it shows |
|---|---|
| **Service** | Name and image, and notes: what it needs to run as several replicas, the old name it still answers to, the proxy in front of it |
| **Replicas** | `−` and `+`. `+` is disabled with the reason when the service can not have more than one |
| **Limits** | The CPU and memory limits **from your compose file** (`cpus`, `mem_limit`, `deploy.resources.limits`). DockGate does not change them |
| **State** | Replicas running, or **drift** when they differ from what was set |
| **Auto-heal** | On: a replica that stays unhealthy is restarted. Uses the service's own health check; without one, the Edge agent checks its port |

## Your files are not changed

DockGate keeps its choices in its own **override file**, `docker-compose.dockgate.yml`, and adds it to every compose command it runs (Up, Rebuild, image updates, Move to Swarm). It is not in the project folder or a Git checkout:

- on DockGate's own server: `DATA_DIR/compose-overrides/local/<project>/`;
- on a remote server: `~/.dockgate/overrides/<project>/`.

Only its owner can read it. **Show the override** shows what is in it; **Back to the files…** removes it, and `docker compose up -d` runs the services as your files say again.

## What can have more than one replica

| Service | Can it? |
|---|---|
| A database (postgres, mysql, mongo, redis…) | **No** — more replicas would be separate databases, not copies |
| A service that writes to a volume or folder | **No** — two replicas would write the same data. A **read-only** mount is fine |
| `network_mode: host` | **No** — two replicas would take the same ports |
| A service with a **host port** (`80:80`) | After a fix: two containers can not take one port, so the port is removed and requests come through the proxy |
| A service with **`container_name`** | After a fix: two containers can not share a name, so the name is dropped — it stays a name other services reach it by |
| Anything else (an API, a frontend, a worker) | **Yes** |

A fix is shown before it is applied, written to the override only, and the service is recreated once. The fixes need Docker Compose 2.24.4 or newer on the server (the panel shows its version).

## What happens when you click

1. DockGate checks the service (above) and writes the override.
2. `docker compose up -d --no-deps --no-recreate --scale <service>=N <service>` — the other services and the replicas already running are not touched.
3. **Fewer replicas:** the ones that go are stopped gracefully first (they finish what they are doing; the proxy sends new requests to the others).
4. **Proxies on the same networks are reloaded** — nginx after `nginx -t` passes (a config that fails its check is left alone), Caddy with `caddy reload`. A plain `proxy_pass http://api:8080;` only looks the name up when nginx starts; the reload makes it see the new replicas.
5. **If compose fails** (an image that can not be pulled, a port taken), the previous override comes back and the service runs as before.
6. Each change is in **Deploy history…** (*replicas*) and in **Observe → Audit log** (`compose_scale`).

## Auto-heal, and who keeps the rules

Turn **Auto-heal** on for a service and a replica that stays unhealthy is restarted: after 3 failed checks in a row, not in its first 60 seconds, at most 3 times an hour — then it stops trying and tells you (Settings → Notifications → *Auto-heal restarted a Compose container*).

The note under the table says who keeps these rules:

- **The Edge agent on that server**, when it runs the current version: it also brings back replicas that are gone (a `docker rm`, a crash with no restart), and keeps doing both while DockGate is offline. How it is commanded without a port: [Edge agent → How DockGate commands it, safely](agent-security.md).
- **DockGate**, otherwise: it heals services that have their own health check while it is online.

## nginx in front

For replicas to share the traffic, nginx must reach the service by its name. Two ways, both work with DockGate:

```nginx
# static: DockGate reloads nginx after each change
location / { proxy_pass http://api:8080; }

# dynamic: nginx looks the name up by itself every 10 s
resolver 127.0.0.11 valid=10s;
set $api http://api:8080;
location / { proxy_pass $api; }
```

The panel says which one each nginx uses.

## Drift

If someone runs `docker compose up` on the server without DockGate's override, the replicas go back to what the files say. The panel shows **drift** and a **Fix** button; DockGate does not fight it on its own.

## Good to know

- Replicas share the service's limits each: 3 replicas of `cpus: 0.5` can use 1.5 CPU together. Keep an eye on the server's total.
- An app that keeps sessions in memory loses them between replicas — keep sessions in Redis or a database, or in a cookie.
- Deleting the stack removes DockGate's override and choices too.
- A project on Swarm is scaled in **Swarm → Services** and **Swarm → Auto Scaling** instead.

## Errors and fixes

| You see | Why | What to do |
|---|---|---|
| `database: more replicas would be separate databases, not copies — it stays at 1` | Database image | Keep one; use the database's own replication |
| `writes to /data: two replicas would write the same data — it stays at 1` | A writable volume or folder | Make the mount read-only if it is, or keep one |
| `<service> needs its host port moved behind the proxy …` | A published port | Accept the fix; reach it through the proxy |
| `… needs Docker Compose 2.24.4 or newer on the server` | Old Compose | Update Docker Compose on the server |
| `A deploy of this project is running — try again when it ends` | A deploy or rebuild is running | Wait for it |
| `<service> could not run N replicas: … — the previous setting is back` | Compose failed (image, port…) | Read the message; nothing changed |
| `Replicas: a whole number from 0–20` | Out of range | 0 to 20 |
| nginx: `host not found in upstream "api"` when nginx restarts | A static `proxy_pass` needs the service up when nginx starts | Add `depends_on: [api]` to nginx, or use the resolver form above |
