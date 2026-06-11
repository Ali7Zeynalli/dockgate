# ---- Stage 1: builder ----
# Native modulları (better-sqlite3, node-pty) build toolchain ilə qurur.
# Toolchain yalnız bu mərhələdə qalır — final image-ə daşınmır.
FROM node:18-alpine AS builder

WORKDIR /app

# Native build üçün lazımi alətlər (yalnız builder mərhələsində)
RUN apk add --no-cache python3 make g++ gcc linux-headers

# Lock-fayl ilə reproduktiv install (npm ci) — optional dependency-lər (node-pty) də daxil
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: runtime ----
# Yalnız runtime — build toolchain yox, image kiçik qalır.
FROM node:18-alpine

WORKDIR /app

# Host Docker / Compose idarəsi üçün docker CLI (build toolchain DEYİL).
# openssh-client: uzaq SSH host-da compose/stack əməlləri üçün (DOCKER_HOST=ssh:// connhelper ssh-ə bağlıdır).
RUN apk add --no-cache docker-cli docker-cli-compose openssh-client

# Hazır qurulmuş node_modules-i builder-dən köçür (eyni node:18-alpine → ABI uyğun)
COPY --from=builder /app/node_modules ./node_modules

# Tətbiq kodu (.dockerignore node_modules-i istisna edir → köçürülən qalır)
COPY . .

# Data qovluğu (settings, tags, history, ssh-keys)
RUN mkdir -p /app/data

EXPOSE 7077

ENV NODE_ENV=production
ENV PORT=7077

CMD ["npm", "start"]
