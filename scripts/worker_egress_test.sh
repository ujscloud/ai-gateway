#!/usr/bin/env bash
# Requires a prebuilt Worker bundle and Node >=22. No Cloudflare login/deploy.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deps="$(mktemp -d)"
trap 'rm -rf "$deps"' EXIT
# Match the workerd/Miniflare version used by pinned Wrangler 4.120.0.
npm install --prefix "$deps" --no-audit --no-fund miniflare@5.20260801.1-alpha
EGRESS_MINIFLARE_MODULE="$deps/node_modules/miniflare" node "$root/scripts/worker_egress_test.cjs"
