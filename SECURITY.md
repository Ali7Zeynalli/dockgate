# Security policy

DockGate controls Docker and servers, so security problems matter. Thank you for reporting them responsibly.

## Supported versions

Only the **latest release** gets security fixes. Update with **Settings → Software update**, or:

```bash
docker compose pull && docker compose up -d
```

## Report a vulnerability

**Please do not open a public issue.**

Report it privately on GitHub: open the repository's **Security** tab and click **Report a vulnerability**
(direct link: https://github.com/Ali7Zeynalli/dockgate/security/advisories/new).

Include:

- the DockGate version (bottom of the sidebar),
- what an attacker can do, and what access they need first,
- steps to reproduce, or a proof of concept,
- your suggested fix, if you have one.

You will get an answer within **7 days**. Once a fix is released, the advisory is published and you are credited, unless you prefer not to be.

## Before you report: how DockGate is meant to run

Some things are by design and are not vulnerabilities on their own:

- **The Docker socket is root on the host.** Anyone who is signed in to DockGate can control the host. DockGate has one admin and no roles.
- **DockGate should not be open to the internet.** Reach it through a VPN or an SSH tunnel.
- The first-run setup from outside the local network needs the setup token from the container log.

Problems in these areas **are** in scope, for example:

- signing in, or using the API or WebSocket, without the admin password;
- reading saved secrets (SSH keys, registry logins, Swarm secrets, notification tokens) without signing in;
- cross-site request forgery, or script injection in the interface;
- escaping the folder limits of the file browsers;
- SSH host key checks being skipped.
