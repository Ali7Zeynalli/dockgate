# DockGate SSH honeypot. DockGate builds this on the server it protects (server/honeypot.js): the build context is
# this folder plus the ssh2 library DockGate already ships (pure JavaScript, no compiler and no npm needed there).
FROM node:22-alpine
LABEL dockgate.role=honeypot-image
WORKDIR /app
COPY node_modules ./node_modules
COPY src ./src
# Runs as an unprivileged user; DockGate starts it read-only, without capabilities, with memory/CPU/process limits.
USER 10001:10001
ENV NODE_ENV=production
EXPOSE 2222
CMD ["node", "src/index.js"]
