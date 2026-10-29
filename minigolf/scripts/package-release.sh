#!/usr/bin/env bash
# Builds a production release archive: dist/ plus production node_modules.
set -euo pipefail
out=${1:?usage: package-release.sh <out.tar.gz>}
npm ci
npm run build
npm prune --omit=dev
tar -czf "$out" dist node_modules package.json package-lock.json
