#!/usr/bin/env bash
# Sync the shared risk core into the Worker bundle and the browser assets.
set -euo pipefail
cd "$(dirname "$0")"

cp ../risk-core.js ./risk-core.js
cp ../risk-core.js ./public/risk-core.js

echo "synced risk-core.js -> worker + public/"
ls -la risk-core.js public/risk-core.js
