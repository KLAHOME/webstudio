# Production image for the self-hosted Webstudio Builder app (KLAHOME).
#
# Self-hosting the Builder in production is explicitly "not recommended" by
# upstream docs, which only document a VS Code dev-containers path. This
# Dockerfile builds the real production artifacts instead (remix vite:build +
# remix-serve), following apps/builder/package.json's own "build"/"start"
# scripts and the root "migrations" script.
#
# Whole-repo copy is used (not a pruned deploy bundle) because pnpm workspaces
# rely on symlinked node_modules across packages; the monorepo does not ship
# a standalone/pruned output. This makes the image larger than necessary but
# correct. Revisit with `pnpm deploy` / turbo prune if image size matters.

FROM node:22-bookworm AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter=@webstudio-is/prisma-client generate
RUN pnpm -r --filter='!./fixtures/*' build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

WORKDIR /app
COPY --from=build /app /app

WORKDIR /app/apps/builder
ENV NODE_ENV=production
EXPOSE 3000

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
