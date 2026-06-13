# DockGate Notifier Agent — outbound-only per-server Docker event watcher.
# Built by DockGate, deployed onto each managed host. No inbound ports; the only
# listener is a loopback health endpoint for the Docker HEALTHCHECK below.
FROM node:22-alpine
WORKDIR /app

# Install deps first for layer caching. nodemailer is pure JS; dockerode here only
# opens the local unix socket, so no native build / ssh2 bits are exercised.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production AGENT_HEALTH_PORT=9000
# Run as the built-in non-root user.
USER node
EXPOSE 9000

# wget ships in alpine busybox. Health = event stream connected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:9000/healthz || exit 1

CMD ["node", "src/index.js"]

# Run-time hardening is set by the DEPLOYER (DockGate), not baked here:
#   --restart unless-stopped  --memory 96m  --cpus 0.25
#   --security-opt no-new-privileges
#   -v /var/run/docker.sock:/var/run/docker.sock:ro   (READ-ONLY socket)
#   NO published ports (outbound-only)
