#!/usr/bin/env bash
# Cross-Sectional Momentum decile study — parameter sweep runner.
#
# Read-only. Executes xmom_decile_study.sql against the Postgres `candles` table
# for a grid of (lookback, holding) combinations and tees each run to
# docs/analysis/.runs/<ts>-xmom/. No engine state is touched.
#
# Usage:  scripts/research/cross-sectional-momentum/run.sh
#
# Connection: piped through `docker compose exec postgres psql` as the
# trade_bot role (read-only SELECTs only; the script issues no writes beyond a
# session-local TEMP TABLE that is dropped ON COMMIT).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SQL="${REPO_ROOT}/scripts/research/cross-sectional-momentum/xmom_decile_study.sql"
STAMP="$(date +%Y%m%d-%H%M)"
OUT_DIR="${REPO_ROOT}/docs/analysis/.runs/${STAMP}-xmom"
mkdir -p "${OUT_DIR}"

# Liquidity floor (median 5m dollar-volume), sub-window count, per-leg cost bps.
FLOOR="${FLOOR:-20000}"
NW="${NW:-3}"
COST="${COST:-10}"

# (lookback_hours, holding_hours) combinations to sweep.
COMBOS=(
    "6 6"
    "24 24"
    "72 24"
    "72 72"
)

echo "cross-sectional-momentum sweep -> ${OUT_DIR}"
echo "floor=${FLOOR} nw=${NW} cost_bps_per_leg=${COST}"

for combo in "${COMBOS[@]}"; do
    read -r LB HD <<<"${combo}"
    label="lb${LB}_hd${HD}"
    echo "  running ${label} ..."
    docker compose -f "${REPO_ROOT}/docker-compose.yml" exec -T postgres \
        psql -U trade_bot trade_bot -P pager=off \
        -v lb="${LB}" -v hd="${HD}" -v floor="${FLOOR}" -v nw="${NW}" -v cost="${COST}" \
        -f - < "${SQL}" \
        >"${OUT_DIR}/${label}.out" 2>"${OUT_DIR}/${label}.err" || {
            echo "    FAILED ${label} (see ${label}.err)"; continue;
        }
done

echo "done. outputs in ${OUT_DIR}"
