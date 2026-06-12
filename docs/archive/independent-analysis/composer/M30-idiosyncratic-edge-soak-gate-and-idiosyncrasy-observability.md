# Independent Review — M30 Idiosyncratic-Edge Soak Gate + Idiosyncrasy Observability

**Plan reviewed:** `docs/plans/archive/M30-idiosyncratic-edge-soak-gate-and-idiosyncrasy-observability.md`  
**Codebase snapshot:** 2026-06-11 (post-M29 commit `fbadab8`, plan written same day)  
**Reviewer:** Cursor (independent analysis)

---

## Executive Verdict

M30 is the correct next milestone after M29: it refuses the WIP’s premature slot-C build, formalizes the **≥20 closed / ≥3 trading days** gate as an executable query, and adds the miss-distance observability `getFunnelSummary` explicitly deferred. The **measurement-first, minimum-touch** posture (one provably-tightening pure-function guard + read-only analysis SQL) matches CLAUDE.md survival priorities and M29 D1.

The plan’s code-verified claims on **production `idiosyncrasy_min_score = 0.5`**, **undifferentiated correlated plumbing**, and **near-zero-noise idiosyncrasy inflation** are accurate and well-argued. D2’s R-multiple contract (`effectiveRiskUsdt` denominator, null-not-fallback) correctly mirrors ADR 0004 §8a.

**Two implementation gaps block dispatch as written:**

1. **`effectiveRiskUsdt` is not persisted** on `decisions` or `positions` — M29 added it to `IIntentSizing` in memory only; `buildGateGeometry` persists `notional` / `stop_loss` but not `effectiveRiskUsdt` or `riskPerTradeUsdt`.
2. **`decisions.position_id` is never written** in live `StrategyService.persistDecision` — analysis queries (`listPositions`, `compareVersions`) already assume `position_id IS NOT NULL` on gate-approved opens, but no engine path stamps it today. D2’s “join closed positions to their open decision” must specify a **fallback join** (LATERAL by symbol/version/time, or position-native fields) until `position_id` backfill lands.

**Assessment:** **Approve with amendments** — ship D2 + D3 + D4 + ADR/tech-debt after resolving persistence/join semantics for R-multiples, scoping D4 engine change vs “analysis-only restart,” and optionally splitting a tiny engine persistence slice if derivation from fill geometry is insufficient for clamp-distortion accuracy.

| Area | Grade | Assessment |
|------|-------|------------|
| Sequencing / D1 (defer slot C) | A+ | Re-affirms M29; soak has not run; gate un-meetable today — correct. |
| Problem statement (WIP stale 0.3 vs 0.5) | A | Seed `BASE_PARAMS.idiosyncrasy_min_score: 0.5` verified; WIP examples still fail at 0.5. |
| D2 edge report design | A− | Quant contract is sound; **data model gap** on `effectiveRiskUsdt` + `position_id`. |
| D3 miss distribution | A | Threshold via `strategy_versions_id` param (not `status='active'`) is critical and correct. |
| D4 noise floor | B+ | Direction safe; inertness argument holds for **triggered** bar moves; caller audit required. |
| D5 out-of-scope discipline | A | Threshold, slot model, VWAP stop untouched — correct. |
| Tests / QA plan | A− | ~48 tests reasonable; must add join-path + derivation fixtures for D2. |
| Post-deploy / success criteria | A | Code-complete vs deploy-acceptance split is honest; `slotCGateOpen=false` on day 1 is success. |
| Scope consistency (“no migration”) | B | D2 may need either SQL derivation rules or a small persistence addendum — plan should pick one. |

**Bottom line:** **Yes** to M30 intent and scope. **Amend** D2 implementation to define how `effectiveRiskUsdt` and open-decision linkage are obtained from **existing columns** (or add an explicit, minimal engine persistence step if derivation is rejected). **Clarify** that only D4 requires engine restart; new analysis queries are package-level like M29. With those amendments, **approve for implementation** under the standard wave: engine (D4) + analysis (D2/D3) → `bot-qa-engineer` → parallel reviewers → `bot-scribe`.

---

## Verified Current State

### M29 soak instrument exists; edge report does not

`getFunnelSummary` (`packages/analysis/src/query/getFunnelSummary.ts`) rolls up open decisions and explicitly defers R-multiples:

```58:59:packages/analysis/src/query/getFunnelSummary.ts
    // R-multiples are NOT computed here — deferred to a future positions-linked
    // rollup keyed on `effectiveRiskUsdt` (post-M29 sizing field).
```

M30’s D2 is exactly that deferred surface. The plan correctly treats it as the slot-C go/no-go instrument.

### Production idiosyncrasy threshold is 0.5 (plan correct)

```13:26:apps/engine/src/database/migrations/20260522020000-SeedStrategyVersions.ts
const BASE_PARAMS = {
    ...
    idiosyncrasy_min_score: 0.5,
    ...
    tier1_min_abs_move_pct: 0.8,
    tier2_min_abs_move_pct: 1.2,
    tier3_min_abs_move_pct: 1.5,
```

v0 has `status: ACTIVE` in seed; live paper uses `ACTIVE_STRATEGY_VERSION_ID=3` → momentum v2 row. D3’s warning against `WHERE status='active'` is **load-bearing** — a query that reads v0’s params would use the same 0.5 base today but wrong version context for future param divergence.

### `computeIdiosyncrasyScore` — plan’s edge cases match code

```6:16:apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts
export function computeIdiosyncrasyScore(btc5mMovePct: number, coin5mMovePct: number): number {
    const coinMagnitude = Math.abs(coin5mMovePct);

    if (coinMagnitude === 0) {
        return IDIOSYNCRASY_SCORE_MIN;
    }

    const raw = 1 - Math.abs(btc5mMovePct) / coinMagnitude;

    return Math.min(IDIOSYNCRASY_SCORE_MAX, Math.max(IDIOSYNCRASY_SCORE_MIN, raw));
}
```

Existing tests cover zero coin move, BTC=0 → 1.0, and a tiny-denominator finite case (`0.00001` / `0.000001`) but **do not pin** the noise-inflation pass at 0.75 the plan cites. D4 tests fill a real gap.

**Caller context (D4 inertness):** live idiosyncrasy uses **bar-aligned** moves at volatility detection:

```281:284:apps/engine/src/market-data/service/MarketDataService.ts
            idiosyncrasyScore: computeIdiosyncrasyScore(this.context.btc5mBarMovePct(), snapshot.fiveMinMovePct),
```

Triggers require `tier*_min_abs_move_pct` ≥ 0.8% — so a `0.05%` floor is structurally below any event that reached the strategy. The plan’s “16× below tier-1” argument holds for **production trigger paths**. Grep should still confirm no shadow/telemetry caller passes sub-threshold moves (plan already requires this).

### `effectiveRiskUsdt` is computed but not persisted (critical gap)

`PositionSizer` computes and returns `effectiveRiskUsdt` on `IIntentSizing`. `StrategyService.buildGateGeometry` persists only:

```423:433:apps/engine/src/strategy/service/StrategyService.ts
    private buildGateGeometry(intent: IOrderIntent, decision: IRiskDecision): IDecisionGeometry {
        return {
            gateAllowed: decision.outcome === RiskOutcomeEnum.APPROVED,
            ...
            notional: decision.approvedSizing?.notional.toFixed() ?? null,
            leverage: decision.approvedSizing?.leverage.toFixed() ?? null,
            ...
        };
    }
```

No `effectiveRiskUsdt`, no `riskPerTradeUsdt`. `PositionEntity` has no `effective_risk` column. **D2 cannot read `effectiveRiskUsdt` from the DB as written.**

**Derivation option (no migration):** for gate-approved open rows with `notional`, `stop_loss`, and a join to `positions.entry_price`:

\[
\text{effectiveRiskUsdt} \approx \frac{\text{notional}}{\text{entryPrice}} \times |\text{entryPrice} - \text{stopLoss}|
\]

Use **position** `entry_price` / `entry_notional` at fill (authoritative) with decision geometry as fallback. Document that step-rounding and fill slippage may make this **slightly differ** from pre-round `IIntentSizing.effectiveRiskUsdt` — acceptable if ADR §8b states “reporting uses fill-anchored reconstruction.”

**`clampedTradeCount`:** compare reconstructed effective risk to `riskPerTradeUsdt` target passed as query param (`accountCapitalUsdt × riskPerTradePct`, mirroring engine config) — not from DB.

### `decisions.position_id` is never stamped (join gap)

`persistDecision` does not set `positionId`. Yet `listPositions` and `compareVersions` join:

```139:145:packages/analysis/src/query/listPositions.ts
        LEFT JOIN LATERAL (
            SELECT event_id
            FROM decisions
            WHERE position_id = p.positions_id
            ...
        ) d_open ON true
```

Until first fills + a backfill/write path exist, this join returns null. **D2 should not rely solely on `position_id`.** Prefer:

1. **Primary filter:** `positions.correlation_mode = 'idiosyncratic'` (column exists on `PositionEntity`).
2. **Open-decision join:** `LATERAL` on `(strategy_version_id, symbol, action='open', gate_allowed=true, ts <= opened_at)` `ORDER BY ts DESC LIMIT 1`, matching patterns in `compareVersions` comments but without requiring `position_id`.
3. **Future:** optional engine follow-up to set `decisions.position_id` on fill (out of M30 scope unless gate report is blocked).

### Correlated path — plan accurate; use position `correlation_mode` for D2 filter

`resolveCorrelationMode` in snapshot mapper emits `CORRELATED` at `|btc_5m| ≥ 1.5%`. Filtering D2 to idiosyncratic closes via `positions.correlation_mode` is more reliable than `market_snapshot->>'correlation_mode'` on a loosely joined decision row.

---

## Decision Critique

### D1 — Soak read-out, not slot C

| Pros | Cons |
|------|------|
| Direct continuation of M29 D1 and tech-debt gate. | 14+ day wait may frustrate WIP momentum — acceptable. |
| “Gate open = enough sample, not positive edge” prevents false green-light. | Correlated buffer still consumes signals while strategy deferred. |

**Verdict:** **Ship.** Strongest decision in the plan.

---

### D2 — `getIdiosyncraticEdgeReport`

| Pros | Cons |
|------|------|
| `effectiveRiskUsdt` denominator matches ADR §8a quant rule. | **Not persisted** — plan assumes field on open decision. |
| `slotCGateOpen` = count floors only; robustness advisory — avoids flat-BTC trap. | `position_id` join may be empty for first fills. |
| `rMultipleStdError`, clamp fraction — operator-friendly uncertainty. | Fill vs intent notional may skew clamp fraction if only decision `notional` used. |
| `btc_5m_*` labels honest about non-regime proxy. | Pre-M29 rows: exclusion path must be tested with zero false inclusion. |

**Verdict:** **Ship design**, **amend implementation** with explicit derivation/join spec (see H1, H2).

---

### D3 — `getIdiosyncrasyMissDistribution`

| Pros | Cons |
|------|------|
| Answers “marginal miss vs deep beta” without moving threshold. | Fixed 0.1-wide buckets may bunch marginal rejects near 0.4–0.5 (plan acknowledges in risks). |
| Version-id param avoids v0 `status='active'` trap. | Rows missing `idiosyncrasy_score` in snapshot need explicit “unknown” bucket (plan mentions). |

**Verdict:** **Ship.** Sibling query (not extending `getFunnelSummary`) matches M29 pattern.

**Minor doc nit:** D3 text alternates “four” and “five” buckets — implementation should use five as specified.

---

### D4 — Noise floor `IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05`

| Pros | Cons |
|------|------|
| Provably tightening only — never opens trades. | Technically violates strict “no trading behaviour change” — plan honest-framing is right. |
| Below tier trigger floors — inert for real events. | If tier mins are lowered in future, floor must be re-derived (plan notes in ADR). |
| Pure function — backtest/live parity preserved. | Existing spec line 67–69 already shows high score for tiny coin move — D4 **will** change that test (expected). |

**Verdict:** **Ship** with caller grep + tier-magnitude regression as plan specifies.

**Note:** This is the **only** change requiring **engine restart**. Analysis queries (D2/D3) deploy with package/MCP usage — post-deploy step 3 wording should distinguish D4 smoke from running SQL instruments.

---

### D5 — Do not touch threshold / slot / VWAP / DB params

**Verdict:** **Correct discipline.** D3 is evidence for a **future** calibration milestone, not M30.

---

## Must-fix before dispatch

### H1 — Define how D2 obtains `effectiveRiskUsdt` without a migration

Pick one approach and document in ADR §8b:

**Option A (recommended, no migration):** Reconstruct from persisted fill/decision geometry:

- Join closed `positions` → best-effort open `decisions` (LATERAL, H2).
- `effectiveRiskUsdt = entry_notional / entry_price × |entry_price − stop_loss_price|` using position columns; fall back to decision `notional` + `stop_loss` + `market_snapshot->>'vwap_session'` only when position fields null.
- `riskPerTradeUsdt` target from query params (`IGetIdiosyncraticEdgeReportParams`: `versionId`, `from`, `to`, `accountCapitalUsdt`, `riskPerTradePct`).
- Rows where geometry is incomplete → null R, excluded from aggregate (same as pre-M29 rule).

**Option B (engine addendum, still no schema if JSON-only):** Extend approved gate rows to persist `effectiveRiskUsdt` into `market_snapshot` or a new nullable M27-style text column — **conflicts** with “no migration” unless snapshot schema extended in shared (also out of scope). Not recommended for M30.

Do **not** implement D2 assuming a column named `effectiveRiskUsdt` exists on `decisions`.

### H2 — Specify open-decision join without relying on `position_id`

Add to implementation step 2:

```sql
LEFT JOIN LATERAL (
  SELECT d.market_snapshot, d.notional, d.stop_loss, d.ts
  FROM decisions d
  WHERE d.strategy_version_id = p.strategy_version_id
    AND d.symbol = p.symbol
    AND d.action = 'open'
    AND d.gate_allowed = true
    AND d.ts <= p.opened_at
  ORDER BY d.ts DESC
  LIMIT 1
) open_dec ON true
```

Filter idiosyncratic: `p.correlation_mode = 'idiosyncratic'` (and/or `open_dec.market_snapshot->>'correlation_mode'` when position null on legacy rows).

Add tests for: (a) join picks latest qualifying open before `opened_at`; (b) correlated close excluded; (c) ambiguous multi-open same symbol — document behaviour.

### H3 — D3 threshold SQL

Mirror `getPerformance` version lookup:

```sql
SELECT (sv.params->>'idiosyncrasy_min_score')::numeric
FROM strategy_versions sv
WHERE sv.strategy_versions_id = $versionId
```

Pass `versionId` from caller (`ACTIVE_STRATEGY_VERSION_ID` at MCP/script layer — **not** env inside `packages/analysis`). Test fixture where v0 `status='active'` has a different param overlay than v2 id=3.

---

## Should-fix before dispatch

### M1 — Split restart vs analysis deploy in post-deploy checklist

- **D4:** engine restart + inertness on first real trigger.
- **D2/D3:** run via analysis package / MCP / operator script — no engine module change.

### M2 — `clampedTradeFraction` semantics

When using fill-anchored reconstruction, clamp detection should use the same reconstructed effective risk vs param target. Document in interface JSDoc that fraction is **approximate** if fill notional ≠ approved decision notional.

### M3 — D4 test file location

Extend `apps/engine/tests/market-data/indicator/computeIdiosyncrasyScore.spec.ts` (existing) rather than only engine unit path under `src/` — matches repo layout.

### M4 — Optional: `decisions.position_id` tech-debt

If first paper fills land without `position_id` backfill, `listPositions.eventId` and `compareVersions` paired diff undercount. M30 could add a **LOW** tech-debt line: “Stamp `decisions.position_id` on successful open fill” — separate from M30 code unless H2 proves insufficient.

### M5 — Wait protocol (align with Open Questions #1)

Plan already says extend soak vs lower floor. Add explicit backlog: while `slotCGateOpen=false`, prioritize **`sl_outside_liquidation` forensics** (M29 tech-debt) if fill rate stalls — do not open slot C or lower idiosyncrasy threshold under sample pressure.

---

## Test plan additions (for `bot-qa-engineer`)

Beyond the plan’s ~48 tests:

1. **D2 join:** closed position with no `position_id` on decision still links via LATERAL time join; `btc_5m_move_pct` read from joined snapshot.
2. **D2 derivation:** known `entry_notional`, `entry_price`, `stop_loss_price` → expected R-multiple in decimal (no float).
3. **D2 clamp:** reconstructed effective risk &lt; param target → `clampedTradeCount` increments.
4. **D2 incomplete geometry:** missing `stop_loss` → null R, excluded from `n`.
5. **D3 version param:** `versionId=3` reads 0.5 even when v0 is `status='active'`.
6. **D4:** update existing “tiny denominator” test — below-floor returns 0; at `0.05%` exact boundary not floored (`<` guard).

Adversarial (plan list is good): empty range, `n=1` std error, robustness false + `slotCGateOpen` true, score=0.5 excluded from miss histogram.

---

## Post-deploy notes

Agree with plan checklist; emphasize:

1. **pg_dump** before D4 engine restart — no migration.
2. **Stale-halt clear** — still blocking for soak velocity (M23/M28).
3. **Day-1 instruments:** `getIdiosyncraticEdgeReport` → `n≈0`, `slotCGateOpen=false` is **correct success**.
4. **D4 inertness:** compare first post-M30 trigger `idiosyncrasy_score` to pre-deploy formula at same bar moves (should match for ≥0.8% coin moves).
5. **D3 immediately useful** even with zero closes — shows `no_eligible_slot` miss shape before fills exist.

---

## Conclusion

M30 is **well-scoped, conservative, and correctly positions measurement before slot-C construction**. The WIP stale **0.3** assumption is properly debunked; D1/D3/D5 are ready. **Amend D2** to address the **unpersisted `effectiveRiskUsdt`** and **unset `decisions.position_id`** before dispatch. **Clarify** engine restart scope (D4 only). With those amendments, **approve for implementation**.
