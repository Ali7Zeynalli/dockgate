# Contributing to DockGate

Thanks for helping. DockGate is maintained by **Ali Zeynalli**. Bug reports, fixes, docs and ideas are all welcome.

## Before you start

- **Found a bug?** Open an issue with the *Bug report* form: what you did, what you expected, what happened, and the DockGate version (bottom of the sidebar).
- **Want a feature?** Open a *Feature request* first, so we can agree on it before you write code.
- **Found a security problem?** Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

DockGate is for **one admin** who runs their own servers. Changes that add user roles or multi-tenant features are out of scope.

## Run it locally

You need Docker (with the Compose plugin) or Node.js 20+ (the image uses Node 22).

**With Docker** — builds from your checkout and mounts `server/` and `public/`, so a restart picks up your changes:

```bash
git clone https://github.com/Ali7Zeynalli/dockgate.git
cd dockgate
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

**With Node:**

```bash
npm install
npm run dev
```

Open http://localhost:7077. DockGate needs access to a Docker daemon (`/var/run/docker.sock`).

## Project layout

| Folder | What is in it |
|---|---|
| `server/` | Express API, Docker / SSH / Swarm logic. Routes are in `server/routes/` |
| `public/` | The web interface: plain JavaScript, no build step. Pages are in `public/js/pages/` |
| `public/vendor/` | Bundled front-end libraries (xterm.js, Chart.js, Socket.IO) |
| `test/unit/`, `test/integration/` | Tests (Node's built-in test runner) |
| `agent/` | The optional Edge agent |

## Make a change

1. Fork the repo and create a branch from `main`, e.g. `fix/volume-clone`.
2. Keep the change focused: one fix or one feature per pull request.
3. Follow the style around you: plain JavaScript, no new build tools, no new front-end frameworks.
4. Add or update tests for what you change.
5. Run the tests:

   ```bash
   npm test
   ```

6. Try it in a running DockGate, not only in tests.

## Version and changelog

Every change that reaches `main` gets a new version:

- `package.json` and `package-lock.json` (`"version"`, two places in the lock file),
- the two version badges at the top of `README.md`,
- a new entry at the top of `CHANGELOG.md`:

```markdown
## [2.40.0] - 2026-12-01

### Fixed
- **What was wrong, in one line.** What happens now, in plain words.
```

Use `Added`, `Changed` or `Fixed`. Write for the person who uses DockGate, not for the code.

## Pull requests

- Describe what changed and why, and how you checked it.
- Screenshots help for anything in the interface.
- Keep the copyright and author notices as they are (see [LICENSE](LICENSE)).

Merging is done by the maintainer.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE) of this project. The original author attribution — **Ali Zeynalli** — must be kept in all copies and derivative works.
