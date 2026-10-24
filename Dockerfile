# syntax=docker/dockerfile:1
#
# Three targets (the last stage is the default):
#   build    compiles the API (generates the Prisma client first: it is git-ignored)
#   migrate  `docker build --target migrate`: build + the Prisma CLI, runs `prisma migrate deploy` (Cloud Run Job)
#   runtime  the API itself: production dependencies and dist/ only, non-root
# No secrets are baked in: every setting arrives as an environment variable when the container starts.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma7.config.ts nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate --config prisma7.config.ts && npm run build

FROM build AS migrate
USER node
CMD ["npx", "prisma", "migrate", "deploy", "--config", "prisma7.config.ts"]

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main"]
