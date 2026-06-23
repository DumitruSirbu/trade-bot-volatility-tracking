#!/usr/bin/env bash
# Reward:risk (TP:SL) geometry sweep harness.
#
# Runs the backtest CLI once per target TP:SL ratio (0.5/1.0/1.5/2.0 by default) over the SAME
# soak window and strategy version, then aggregates the reports into a timestamped markdown in
# docs/analysis/. The stop is re-derived to `TP_distance / ratio`; the take-profit is unchanged;
# position size is re-derived by the risk gate from the new stop (realistic risk-based sizing).
#
# This is the sibling of timestop-sweep.sh — a SEPARATE, reusable harness. Re-run any time; each
# run writes its own dated file so runs can be compared over time.
#
# Safety: identical contract to timestop-sweep.sh — the backtest CLI is spawned with a MINIMAL
# env allowlist (PATH, HOME, NODE_ENV, DATABASE_URL), NO exchange keys, reads the soak Postgres
# read-only, writes nothing to the database, and does NOT touch the live soak engine.
#
# Usage:
#   scripts/analysis/rr-sweep.sh [FROM_UTC] [TO_UTC] [VERSION_ID] [RATIOS_CSV]
# Defaults: FROM=2026-06-09 TO=2026-06-24 VERSION=3 RATIOS=0.5,1.0,1.5,2.0
set -euo pipefail

FROM_UTC="${1:-2026-06-09}"
TO_UTC="${2:-2026-06-24}"
VERSION_ID="${3:-3}"
IFS=',' read -r -a RATIOS <<< "${4:-0.5,1.0,1.5,2.0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M)"
RAW_DIR="${REPO_ROOT}/docs/analysis/.runs/rr-${RUN_ID}"
OUT_MD="${REPO_ROOT}/docs/analysis/rr-sweep-${RUN_ID}.md"
DB_URL="${DATABASE_URL:-postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot}"

mkdir -p "${RAW_DIR}"
echo "[rr-sweep ${RUN_ID}] window=${FROM_UTC}->${TO_UTC} version=${VERSION_ID} ratios=${RATIOS[*]}"

REPORTS=()
for rr in "${RATIOS[@]}"; do
    out="${RAW_DIR}/rr${rr}.json"
    echo "[rr-sweep ${RUN_ID}] running target-rr=${rr} ..."
    env -i \
        PATH="${PATH}" HOME="${HOME}" NODE_ENV=production DATABASE_URL="${DB_URL}" \
        bash -c "cd '${REPO_ROOT}/apps/engine' && exec node_modules/.bin/ts-node -r tsconfig-paths/register src/backtest/cli/BacktestCli.ts run --version ${VERSION_ID} --from ${FROM_UTC} --to ${TO_UTC} --target-rr ${rr} --output '${out}'" \
        >"${RAW_DIR}/rr${rr}.stdout.log" 2>"${RAW_DIR}/rr${rr}.stderr.log"
    REPORTS+=("${out}")
    echo "[rr-sweep ${RUN_ID}] done rr=${rr} -> ${out}"
done

node "${REPO_ROOT}/scripts/analysis/rr-sweep-aggregate.mjs" \
    "${RUN_ID}" "${FROM_UTC}" "${TO_UTC}" "${VERSION_ID}" "${OUT_MD}" "${REPORTS[@]}"

echo "[rr-sweep ${RUN_ID}] markdown -> ${OUT_MD}"
