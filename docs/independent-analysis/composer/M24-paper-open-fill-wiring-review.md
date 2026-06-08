# Independent Review — M24 Paper Open-Fill Wiring

**Plan reviewed:** `docs/plans/M24-paper-open-fill-wiring.md`  
**Codebase snapshot:** 2026-06-08 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M24 correctly identifies the **root cause of zero paper positions**: not strategy, not the risk gate, but the live streaming fill adapter passing an **empty intra-bar tick array** into the shared missed-fill detector. With `MARKETABLE_LIMIT_IOC`, `isMissedFill` returns `true` before any price logic runs — every open is recorded as missed (`fillPrice=0`, no position). The stale comment in `StreamingFillAdapter` claiming a "limit-vs-mark fallback" is **wrong**; the architect analysis and plan diagnosis are **code-verified**.

Synthesizing **one quote-derived tick** from the cached WS snapshot is the right fix: it supplies the touch evidence a marketable-limit IOC needs without changing the shared contract or inventing a favorable price. Slippage stays tier-floor (`lowFidelity: true`). Scope is correctly limited to `StreamingFillAdapter` on the live path; M7 historical replay keeps empty-tick conservatism.

**Assessment:** **Approve with amendments** — ship as a code-only, migration-free, engine-only milestone with the plan's test matrix and quant review. Lock **tick synthesis rules** in implementation (shared helper or documented matrix) so they cannot drift from `deriveReferencePrice`. Add ADR 0015 / ADR 0032 notes for the live-streaming exception. Extend QA for **partial-quote fallbacks**, **causality-spec compatibility**, and an **integration test** through `PaperFillSimulator` (not only adapter unit tests).

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A+ | Stale comment + empty `[]` + detector early-return verified; sequencing M24→M25 is correct. |
| Fix approach (snapshot tick) | A | Correct IOC semantics; fidelity bump not a cheat; matches architect P0. |
| Boundary / scope control | A | No shared change; historical adapter untouched; REDUCE_MARKET unaffected. |
| Tick synthesis specification | B | Direction clear; exact high/low/fallback matrix under-specified vs `deriveReferencePrice`. |
| DRY / consistency risk | B- | `limitPrice` set in `PaperFillSimulator`, tick built in `StreamingFillAdapter` — drift possible. |
| Determinism / causality | A- | Snapshot-only synthesis preserves invariants; must not use bar `high`/`low` from snapshot. |
| Test plan | B+ | Good coverage themes; missing partial-quote cases and PaperFillSimulator E2E. |
| Post-deploy expectations | A | Correct: M24 alone may show zero live trades; acceptance is test evidence. |
| DB safety | A | Code-only restart; pg_dump ritual appropriate. |

**Bottom line:** **Yes, implement snapshot-tick synthesis in `StreamingFillAdapter`.** **No, do not relax the shared missed-fill detector or hard-code `missed=false`.** Amend dispatch to **lock synthesis ↔ reference-price consistency**, document the live-path exception in ADR 0015/0032, and add QA for **non-crossing IOC**, **partial quotes**, and **historical-path regression**.

---

## Verified Current State

### Empty ticks guarantee a miss for limit policies

```57:59:packages/shared/src/util/missedFillDetector.ts
    if (ticks.length === 0) {
        return true; // no ticks → cannot confirm fill → missed
    }
```

ADR 0015 §6 documents this as **C6 fidelity-conservatism** for backtest replay when intra-bar evidence is absent. M24 correctly fixes the **adapter** that was inappropriately supplying empty evidence on a path where a live quote *is* the evidence.

### Streaming adapter passes `[]` and the comment is stale

```223:231:apps/engine/src/paper-mode/service/StreamingFillAdapter.ts
        // For PAPER live event-time, intra-bar tick history is empty — the
        // shared core's missed-fill detector falls back to the limit-vs-mark
        // test (M5 IOC semantics) instead of replaying a recorded tick path.
        const orderTimeoutMs = this.resolveOrderTimeoutMs(intent.policy);
        const signalBarOpenMs = snapshot.ts;

        return sharedApplyFill(snapshot, intent, coinTier, tierSlippageParams, seed, [], signalBarOpenMs, orderTimeoutMs, latencyMs);
```

There is **no** limit-vs-mark fallback in `isMissedFill` or `applyFill`. The comment should be replaced — the plan item 2 is mandatory, not cosmetic.

### Opens use `MARKETABLE_LIMIT_IOC`; closes use `REDUCE_MARKET`

```234:249:apps/engine/src/paper-mode/service/PaperFillSimulator.ts
    private translateToFillIntent(intent: IOrderIntent, snapshot: IFillSnapshot): IFillIntent {
        const action = this.translateAction(intent.intentAction);
        const policy = action === 'open' ? OrderPolicyEnum.MARKETABLE_LIMIT_IOC : OrderPolicyEnum.REDUCE_MARKET;
        // ...
        const limitPrice = this.deriveReferencePrice(snapshot, side, reduceOnly);
```

`REDUCE_MARKET` bypasses the tick path in `isMissedFill` (`return false`). M24's open fix unblocks the position lifecycle; exits were never blocked by empty ticks.

### Reference price already uses taker-side bid/ask with fallbacks

```257:280:apps/engine/src/paper-mode/service/PaperFillSimulator.ts
    private deriveReferencePrice(snapshot: IFillSnapshot, side: 'long' | 'short', reduceOnly: boolean): string {
        const wantsAsk = (side === 'long' && !reduceOnly) || (side === 'short' && reduceOnly);
        const primary = wantsAsk ? snapshot.ask : snapshot.bid;
        // ... mark → last → opposite → midpoint ...
```

For a **crossing** marketable IOC, `limitPrice` is set to the taker side (LONG → ask, SHORT → bid). Touch semantics in `anyTickTouchesLimit`:

- **LONG:** `tick.low <= limitPrice` — synthesized `low` should be **bid** (or consistent fallback).
- **SHORT:** `tick.high >= limitPrice` — synthesized `high` should be **ask** (or consistent fallback).

Architect P0 example `high: ask|last, low: bid|last` satisfies this when bid ≤ ask. The plan's consistency requirement is **load-bearing**.

### Historical path loads real ticks — must stay unchanged

```68:77:apps/engine/src/backtest/fill/HistoricalFillAdapter.ts
        const tickSnapshots = this.toTickSnapshots(request.ticks);
        // ...
        const result: ISimulatedFillCore = sharedApplyFill(
            // ...
            tickSnapshots,
```

Backtest fills work because `tick_aggregates` populate `ticks`. M24's regression guard ("historical empty-tick still misses") protects this contract.

### Pre-existing guards: no tick / stale tick → null (not shared miss)

`simulateOrderFill` returns `null` when the symbol has no cached tick or `nowMs - snapshot.ts > STREAMING_FILL_STALE_TICK_MS` (5s). `PaperFillSimulator` maps that to `missedReason: 'no_tick_cached'`. M24 does not need to change these paths; QA should note three distinct miss outcomes: **no cache**, **stale cache**, **detector miss** (non-crossing IOC).

### SL/TP path already synthesizes point ticks (different semantics)

`evaluateOnTick` collapses `high`/`low` to `snapshot.last` for intra-bar stop evaluation (M11a R4 Item 3B). M24 **should not** copy that collapse for opens — opens need **spread-aware** `high`/`low` so the touch test reflects bid/ask, not a single last price.

---

## Decision Critique — Pros and Cons

### 1. Fix in `StreamingFillAdapter` only (not shared core)

| Pros | Cons |
|------|------|
| Preserves ADR 0015 C6 for backtest when ticks are genuinely absent. | Two adapters now have different "evidence" policies — must stay documented. |
| Smallest blast radius; no `packages/shared/` dispatch wave. | Future third adapter (e.g. shadow P4) must not copy streaming synthesis by mistake. |
| Shared detector remains single source of truth for touch logic. | |

**Verdict:** **Correct.** Matches architect §6 contract notes.

---

### 2. Synthesize one tick from live snapshot (not change `isMissedFill`)

| Pros | Cons |
|------|------|
| Feeds realistic prices; detector still arbiter for cross vs non-cross. | Single-tick path cannot model intra-window price movement (acceptable at `lowFidelity`). |
| Deterministic: built only from `snapshot` fields + fixed rules. | If `limitPrice` and tick disagree due to drift, false miss or false fill. |
| Aligns with "marketable IOC at quote fills" industry semantics. | Does not upgrade to depth-aware fills (correctly deferred). |

**Verdict:** **Correct.** Do **not** force `missed=false` (plan §Boundary explicitly forbids this — good).

---

### 3. Sequencing M24 before M25 (P0 before P1/P2)

| Pros | Cons |
|------|------|
| Proven in architect analysis: v2 + gate relax without fill fix → still zero positions. | Operators may expect visible trades after M24 deploy — plan mitigates in post-deploy §4. |
| Test acceptance decoupled from live gate/strategy state. | Smoke test only confirms boot, not fill path in production. |

**Verdict:** **Correct sequencing.** Post-deploy wording is honest and should stay in scribe output.

---

### 4. Optional `PaperFillSimulator` threading

| Pros | Cons |
|------|------|
| Keeps synthesis next to the snapshot consumer (`StreamingFillAdapter`). | `limitPrice` derived in `PaperFillSimulator` — risk of inconsistent bid/ask vs tick without shared helper. |
| Plan allows single-file change if fields already on `IFillSnapshot`. | `IFillSnapshot` already has bid/ask/last/mark — **PaperFillSimulator change likely unnecessary**. |

**Verdict:** **Prefer one file** (`StreamingFillAdapter`) plus a **small shared private helper** (engine-local, e.g. `buildQuoteTouchTick(snapshot, side, reduceOnly)`) if duplication would otherwise mirror `deriveReferencePrice` logic.

---

## Must-fix before dispatch

### H1 — Lock tick synthesis matrix (consistency with `limitPrice`)

Before engine wave, document and implement **one** rule set, e.g.:

| Field | LONG open | SHORT open |
|-------|-----------|------------|
| `tick.low` | `bid` → `last` → `mark` → midpoint | (touch uses low) |
| `tick.high` | (touch uses high) | `ask` → `last` → `mark` → midpoint |
| `tick.ts` | `new Date(snapshot.ts)` inside `[signalBarOpenMs, signalBarOpenMs + orderTimeoutMs]` |

Requirements:

- When `limitPrice` comes from `ask` (LONG open), `tick.low` must be ≤ `limitPrice` for a normal spread (bid ≤ ask).
- When `limitPrice` comes from `bid` (SHORT open), `tick.high` must be ≥ `limitPrice`.
- **Same fallback chain** as `deriveReferencePrice` when bid/ask missing — or synthesis must use the **actual** `intent.limitPrice` passed into `simulateOrderFill` to build a tick that touches iff the limit crosses (strongest consistency).

**Recommend:** pass `intent` into a `buildStreamingTouchTick(snapshot, intent)` that uses `intent.limitPrice` + side to set `high`/`low` so touch is guaranteed for marketable IOC **by construction** while non-crossing limits (test fixture) still miss. Quant reviewer should sign off.

### H2 — Do not use `snapshot.high` / `snapshot.low` (bar range) for open synthesis

`IFillSnapshot` carries bar-level `high`/`low`. Using them would smuggle bar range into IOC touch (same failure mode M11a fixed for SL/TP). Synthesis must use **quote fields** only.

### H3 — ADR documentation for live-streaming exception

ADR 0015 §6 says empty ticks → missed. Add a short § or footnote: **live streaming adapter supplies one quote-derived tick**; empty-tick miss remains for historical replay. ADR 0032 D15 should cross-reference. Scribe wave — but architect should stub the ADR intent in dispatch brief so reviewers have a contract target.

---

## Should-fix before dispatch

### M1 — Integration test through `PaperFillSimulator`

Unit tests on `StreamingFillAdapter` alone do not prove the full open path (`translateToFillIntent` → adapter → ledger). Add one test: notify tick → `simulateFill` OPEN → `filled: true`, non-zero `fillPrice`, ledger row persisted. Existing idempotency tests stub the adapter — keep those; add a **non-stubbed** fill-success case.

### M2 — Partial-quote / fallback scenarios

`deriveReferencePrice` falls back to mark → last → midpoint. QA should include:

- Bid missing, ask present (and vice versa).
- Both missing, mark present — tick and limit both use mark-derived touch.
- Pathological: limit resolves to mark but tick uses different fallback → assert **miss** (fail-safe), not silent fill.

### M3 — Non-crossing IOC test (detector arbiter)

Plan requires it; specify fixture: e.g. LONG with `limitPrice` below bid (passive/non-crossing) → `filled: false`. Proves M24 did not hard-code success.

### M4 — `StreamingFillAdapter.causality.spec.ts` audit

Existing tests use `limitPrice: '0'` and expect non-null results (missed-fill objects, not `null`). After M24, behavior should remain consistent (still missed for limit 0). Run suite in QA wave; add assertion `filled === false` where appropriate so a future change to limit `0` does not accidentally show a fill.

### M5 — `POST_ONLY_MAKER` future-proofing

Not routed for opens today. If `simulateOrderFill` is ever called with `POST_ONLY_MAKER`, spread-crossing synthesis would be **wrong** (passive rest). Options: (a) document POST_ONLY as out of scope and assert unreachable in streaming open path, or (b) branch synthesis for passive policies. Low urgency — **document in adapter comment**.

### M6 — M7 equivalence regression

Plan cites `src/backtest` green. Explicitly run `M7FillEquivalence.regression.spec.ts` in verification checklist — golden tape must be unchanged.

### M7 — Shadow / P4 separation

Architect P4 (shadow counterfactual fills) is a **separate** empty-tick bug in `ShadowStrategyOrchestratorService`. M24 scribe should **not** claim shadow fills are fixed. Cross-link M26 only.

---

## What looks good

- **Root-cause clarity** — ties zero trades to fill layer with code citations; stale comment called out.
- **"Fidelity correction, not a cheat"** — accurate for marketable IOC at live quote.
- **Boundary section** — live-only, detector arbiter, determinism, `lowFidelity` unchanged.
- **Out of scope** — strategy, gate, shadow, depth-aware, shared core — all correctly deferred.
- **Dispatch waves** — single-file engine dispatch, paired QA, quant reviewer for fidelity argument.
- **DB safety** — migration-free; backup before restart; no strategy of relaxing gate to "see a trade."
- **Post-deploy** — explicit that M24 alone may not produce live transactions.
- **References** — architect P0, ADR 0015, 0032, 0019, follow-on milestones.
- **Sequencing in four-milestone arc** — M24→M25→M26→M27 matches architect §5.

---

## Consciously out of scope (agree with plan)

- `ACTIVE_STRATEGY_VERSION_ID` / v2 activation (M25 P1).
- Paper stress relaxation (M25 P2).
- Slot/capital changes (M25 P3).
- Shadow counterfactual tick evidence (M26).
- Decision/book_snapshots capture (M27).
- Depth-aware slippage (`enableDepthAwareSlippage`).
- Changing `missedFillDetector` empty-tick rule globally.

---

## Comparison to architect analysis

Plan aligns with [main-architector-paper-soak-fill-and-gate-analysis.md](../wip/main-architector-paper-soak-fill-and-gate-analysis.md) §2.3 and P0:

- Same files, same synthesis idea (`high`/`low` from ask/bid|last).
- Same contract: historical conservatism unchanged.
- Same sequencing: P0 unlock before P1/P2.

Composer adds emphasis on **H1 consistency** between `deriveReferencePrice` and tick synthesis, **H2 bar high/low exclusion**, and **PaperFillSimulator integration test** — not contradictions, implementation hardening.

No `docs/independent-analysis/gbt/` or `gemini/` M24 review exists at review time.

---

## Recommended dispatch adjustment (summary)

1. **Engine (`bot-engine-nestjs`)** — Implement `buildStreamingTouchTick` (or equivalent) in `StreamingFillAdapter`; use `intent.limitPrice` + side for touch consistency (H1); quote fields only (H2); replace stale comment; do not touch `HistoricalFillAdapter` or shared package.
2. **QA (`bot-qa-engineer`)** — Plan's five bullets + H1 partial-quote cases (M2) + non-crossing IOC (M3) + `PaperFillSimulator` integration (M1) + causality spec audit (M4) + `M7FillEquivalence.regression.spec.ts` (M6).
3. **Reviewers** — Quant: IOC-at-quote fidelity, not optimistic invention. Logic: historical path cannot reach synthesis; three miss paths distinct. Clean-code: helper extraction vs duplication.
4. **Scribe** — ADR 0015/0032 live-exception note (H3); milestone-log; clarify M24 does not fix shadow (M7); M25 required for first visible soak trades.
5. **Rollout** — pg_dump → engine restart → 10-min smoke (boot only) → test evidence as acceptance; no gate/strategy changes.

With H1–H3 and integration QA, M24 is a **minimal, correct unlock** for the paper position lifecycle — the prerequisite every downstream exploration milestone assumes.
