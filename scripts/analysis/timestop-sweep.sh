#!/usr/bin/env bash
# Time-stop horizon sweep harness.
#
# Runs the backtest CLI once per time-stop horizon (15/30/45/60 min by default) over the SAME
# soak window and strategy version, then aggregates the reports into a timestamped markdown in
# docs/analysis/. Re-run any time to compare against prior runs — each run is its own dated file.
#
# Safety: the backtest CLI boots the engine context but is spawned with a MINIMAL env allowlist
# (PATH, HOME, NODE_ENV, DATABASE_URL) exactly like the MCP run_backtest path — NO exchange keys,
# so it cannot place orders. It reads the soak Postgres read-only. It does NOT touch the live
# soak engine, and it writes nothing to the database.
#
# Usage:
#   scripts/analysis/timestop-sweep.sh [FROM_UTC] [TO_UTC] [VERSION_ID] [HORIZONS_CSV]
# Defaults: FROM=2026-06-09 TO=2026-06-24 VERSION=3 HORIZONS=15,30,45,60
set -euo pipefail

FROM_UTC="${1:-2026-06-09}"
TO_UTC="${2:-2026-06-24}"
VERSION_ID="${3:-3}"
IFS=',' read -r -a HORIZONS <<< "${4:-15,30,45,60}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M)"
RAW_DIR="${REPO_ROOT}/docs/analysis/.runs/${RUN_ID}"
OUT_MD="${REPO_ROOT}/docs/analysis/timestop-sweep-${RUN_ID}.md"
DB_URL="${DATABASE_URL:-postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot}"

mkdir -p "${RAW_DIR}"
echo "[sweep ${RUN_ID}] window=${FROM_UTC}->${TO_UTC} version=${VERSION_ID} horizons=${HORIZONS[*]}"

REPORTS=()
for ts in "${HORIZONS[@]}"; do
    out="${RAW_DIR}/ts${ts}.json"
    echo "[sweep ${RUN_ID}] running time_stop_minutes=${ts} ..."
    env -i \
        PATH="${PATH}" HOME="${HOME}" NODE_ENV=production DATABASE_URL="${DB_URL}" \
        bash -c "cd '${REPO_ROOT}/apps/engine' && exec node_modules/.bin/ts-node -r tsconfig-paths/register src/backtest/cli/BacktestCli.ts run --version ${VERSION_ID} --from ${FROM_UTC} --to ${TO_UTC} --time-stop-minutes ${ts} --output '${out}'" \
        >"${RAW_DIR}/ts${ts}.stdout.log" 2>"${RAW_DIR}/ts${ts}.stderr.log"
    REPORTS+=("${out}")
    echo "[sweep ${RUN_ID}] done ts=${ts} -> ${out}"
done

node "${REPO_ROOT}/scripts/analysis/timestop-sweep-aggregate.mjs" \
    "${RUN_ID}" "${FROM_UTC}" "${TO_UTC}" "${VERSION_ID}" "${OUT_MD}" "${REPORTS[@]}"

echo "[sweep ${RUN_ID}] markdown -> ${OUT_MD}"
