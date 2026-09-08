#!/bin/sh
set -eu

# Applies pending Prisma migrations against DATABASE_URL/DIRECT_URL, then
# starts the Remix production server. Run from apps/builder (see Dockerfile).
#
# The root "migrations" script (see /app/package.json) passes --dev and
# --cwd but no subcommand - it must be invoked with an explicit "migrate"
# argument, which pnpm forwards to packages/prisma-client/migrations-cli.
cd /app
pnpm run migrations migrate

cd /app/apps/builder
exec pnpm run start
