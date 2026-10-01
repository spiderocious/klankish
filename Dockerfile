# =============================================================================
# Klankish — one image, several roles.
#
# The same image runs the API, the worker, the scheduler, or all three, selected
# by PROCESS_ROLE at runtime. That is what makes "split the worker onto its own
# Railway service later" a config change rather than a rewrite.
#
# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no source — only compiled output and production node_modules.
# =============================================================================

# --- deps -------------------------------------------------------------------
# Separate stage so a change to source code does not re-run the install.
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
WORKDIR /app

# argon2 is a native module: it needs a toolchain to compile here, but NOT in
# the runtime image, which is the whole reason for this stage.
RUN apk add --no-cache python3 make g++

# Only the manifests, so this layer caches until a dependency actually changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/expr/package.json   ./packages/expr/
COPY apps/api/package.json        ./apps/api/
COPY apps/web/package.json        ./apps/web/

RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# Order matters: the apps consume the packages' emitted declarations.
RUN pnpm --filter @klankish/expr build \
 && pnpm --filter @klankish/shared build \
 && pnpm --filter @klankish/api build \
 && pnpm --filter @klankish/web build

# Drop dev dependencies from the tree that will be copied into the runtime.
RUN pnpm prune --prod

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# dumb-init reaps zombies and forwards signals, so SIGTERM actually reaches Node
# and the worker gets to drain instead of being killed mid-run.
RUN apk add --no-cache dumb-init

# Non-root. The shell step spawns processes; running those as root on a
# multi-user instance would be indefensible.
RUN addgroup -g 1001 -S klankish && adduser -u 1001 -S klankish -G klankish

COPY --from=build --chown=klankish:klankish /app/node_modules ./node_modules
COPY --from=build --chown=klankish:klankish /app/package.json ./package.json
COPY --from=build --chown=klankish:klankish /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

COPY --from=build --chown=klankish:klankish /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=klankish:klankish /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=klankish:klankish /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=klankish:klankish /app/packages/expr/dist ./packages/expr/dist
COPY --from=build --chown=klankish:klankish /app/packages/expr/package.json ./packages/expr/

COPY --from=build --chown=klankish:klankish /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=klankish:klankish /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=klankish:klankish /app/apps/api/node_modules ./apps/api/node_modules

# Migrations are plain .sql and are NOT compiled by tsc, so they must be copied
# explicitly or the migration step finds an empty directory.
COPY --from=build --chown=klankish:klankish /app/apps/api/src/db/migrations ./apps/api/dist/db/migrations

# The built SPA, which the API serves from the same origin.
COPY --from=build --chown=klankish:klankish /app/apps/web/dist ./apps/web/dist

USER klankish
EXPOSE 3000

# A worker/scheduler-only process still binds this port — without it the
# platform's TCP health check fails and a perfectly healthy worker is killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
