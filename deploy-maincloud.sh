#!/usr/bin/env bash
# Deploy birdgame "Murmuration" to SpacetimeDB Maincloud (shared, internet-wide).
#
# Prereq (one time): the CLI must be authenticated.
#   spacetime login            # opens browser; approve with your spacetimedb.com login
#
# Then just run:  ./deploy-maincloud.sh
set -euo pipefail

DB="${1:-birdgame-murmuration}"

echo "▶ Publishing module to Maincloud as '$DB'…"
spacetime publish --module-path spacetimedb --server maincloud "$DB" -y

echo "▶ Regenerating client bindings…"
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb

cat <<EOF

✅ Deployed to Maincloud: $DB

Play it (shared across the internet):
  npm run dev        # then open  http://127.0.0.1:5173/birdybird/?mp=cloud&db=$DB

Run the LLM hawk against the cloud (separate terminal, with your rotated key set):
  export ANTHROPIC_API_KEY=sk-ant-...
  STDB_HOST=wss://maincloud.spacetimedb.com STDB_DB=$DB npm run agent
EOF
