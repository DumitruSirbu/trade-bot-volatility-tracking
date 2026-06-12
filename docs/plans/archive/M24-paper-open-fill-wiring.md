# M24 — Live/paper open-fill wiring (synthesize WS-snapshot tick so gate-approved opens fill)

> **Sequencing note:** M24 is the first of a four-milestone data-fix arc (M24→M25→M26→M27)
> derived from the architect analysis [main-architector-paper-soak-fill-and-gate-analysis.md](../../wip/done/main-architector-paper-soak-fill-and-gate-analysis.md)
> (2026-06-06). That analysis proved the paper soak produces **zero realized trades** not because of
> the strategy or the risk gate, but because the **live-event-time fill model marks every open as a
> missed fill** — it feeds the shared miss-detector an empty tick array. M24 fixes that one blocker
> (analysis **P0**). It is the **true unlock**: without it, switching strategy (M25 P1) and relaxing
> the gate (M25 P2) still yield zero positions. M24 lands **before** M25. It is code-only, engine-only,
> migration-free, and strictly scoped to the **paper live-streaming** path — the historical/backtest
> path (M7) and live trading defaults are untouched.

## Context

The shared missed-fill detector treats an **empty tick array on any limit policy as a guaranteed
miss** (`packages/shared/src/util/missedFillDetector.ts`):

```49:59:packages/shared/src/util/missedFillDetector.ts
    if (policy === OrderPolicyEnum.REDUCE_MARKET) {
        return false; // market orders always fill
    }

    if (!isLimitPolicy(policy)) {
        return false; // non-limit policies are not modelled as missable
    }

    if (ticks.length === 0) {
        return true; // no ticks → cannot confirm fill → missed
    }
```

In the paper path, opens are translated to `MARKETABLE_LIMIT_IOC`
(`PaperFillSimulator.translateToFillIntent`), and `StreamingFillAdapter.simulateOrderFill` then calls
the shared core with an **empty** tick array:

```223:231:apps/engine/src/paper-mode/service/StreamingFillAdapter.ts
        // For PAPER live event-time, intra-bar tick history is empty — the
        // shared core's missed-fill detector falls back to the limit-vs-mark
        // test (M5 IOC semantics) instead of replaying a recorded tick path.
        const orderTimeoutMs = this.resolveOrderTimeoutMs(intent.policy);
        // Signal-bar open is effectively "now" for live event-time; the
        // shared core's `computeFillTimestamp` advances by `latencyMs` only.
        const signalBarOpenMs = snapshot.ts;

        return sharedApplyFill(snapshot, intent, coinTier, tierSlippageParams, seed, [], signalBarOpenMs, orderTimeoutMs, latencyMs);
```

The comment is **stale** — `isMissedFill` does no "limit-vs-mark" fallback. With
`MARKETABLE_LIMIT_IOC` + `ticks=[]` it returns `true` (missed) **before any price is considered**. The
live WS snapshot is consulted only to derive the *reference price*, never as evidence the price is
touchable. Net effect: **every paper open misses** (`fillPrice=0`, no position); only `REDUCE_MARKET`
(closes/SL/TP) would fill — but a position can never be opened to close. M7 backtest fills work
because `BacktestOrchestrator` loads real `tick_aggregates` and passes them as `ticks`; the live
streaming path never loads or synthesizes a tick.

**The fix is a fidelity correction, not a cheat.** A marketable-limit-IOC that crosses the spread
*should* fill at the live quote. Synthesizing a single tick from the current quote removes an
over-conservative miss; it does not invent a favorable price. Slippage stays tier-floor
(`lowFidelity: true`) exactly as today.

## Review amendments (locked 2026-06-08 — 3 independent analysts)

Independent reviews (`docs/archive/independent-analysis/{composer,gbt,gemini}/M24-paper-open-fill-wiring-review.md`)
unanimously **approve the direction** (synthesize one quote-derived tick in `StreamingFillAdapter`,
no shared-core change, historical path untouched) but flagged two **code-verified** corrections that
change the implementation. Both are folded into the scope below:

- **A1 (must-fix) — tick shape was wrong.** The original example `{ high: ask, low: bid }` is unsafe.
  `anyTickTouchesLimit` reads `tick.low` as the *executable ask path* for a LONG and `tick.high` as
  the *executable bid path* for a SHORT (`packages/shared/src/util/missedFillDetector.ts:87-93`).
  Using the full spread range (`low=bid` for LONG) makes a **non-crossing** inside-spread limit
  falsely fill (e.g. bid=100, ask=101, long limit=100.5 → `low=100 ≤ 100.5` → wrong fill). The
  synthesized tick must be a **side-aware executable-price point**: LONG open → `high=low=ask`;
  SHORT open → `high=low=bid` (with the same fallback chain as `deriveReferencePrice`). This fills a
  crossing IOC by construction while a non-crossing limit still misses, keeping the detector the
  arbiter.
- **A2 (must-fix) — live fill timestamp is 5 minutes late.** `computeFillTimestamp` returns
  `signalBarOpenMs + 5m + latencyMs` (`packages/shared/src/util/fillSimulatorCore.ts:148-152`), a
  next-bar semantic correct for M7 replay but wrong for live event-time. A live open at `snapshot.ts`
  would be stamped `snapshot.ts + 5m + latencyMs`, contaminating transaction ordering, position
  `opened_at`, and every downstream join in the data-fix arc. M24 **normalizes the live-path result
  to `snapshot.ts + latencyMs`** by adjusting `tsMs` in the adapter *after* `sharedApplyFill` — the
  shared core stays unchanged (M7 next-bar semantics preserved).

## Scope

1. **Synthesize a single intra-bar tick from the live WS snapshot** in
   `StreamingFillAdapter.simulateOrderFill`, replacing the `[]` passed to `sharedApplyFill` **only on
   the live streaming path**. The tick is a **side-aware executable-price point** (per amendment A1),
   shaped to `ITickSnapshot`, so the detector confirms the touch for a spread-crossing IOC **without**
   filling a non-crossing inside-spread limit:
   - **LONG open:** `high = low = ask` (the executable taker price; `tick.low` is what the detector
     tests against the limit for LONG).
   - **SHORT open:** `high = low = bid` (the executable taker price; `tick.high` is the detector's
     LONG-mirror test for SHORT).
   - **Fallback chain mirrors `deriveReferencePrice`** (ask/bid → `mark` → `last` → opposite →
     midpoint). When the side-specific quote is missing and a fallback (`mark`/`last`) is used, the
     synthesized point **and** the reference price must use the *same* candidate so they cannot
     contradict. **Prefer a single shared helper** consumed by both `deriveReferencePrice` and the
     tick builder (amendment M1) so the price candidate is chosen once. Use **quote fields only** —
     never the snapshot's bar-level `high`/`low` (that would smuggle bar range into IOC touch, the
     same failure mode M11a fixed for SL/TP).
   - The tick `ts` sits inside the IOC window (`signalBarOpenMs = snapshot.ts`,
     `orderTimeoutMs = resolveOrderTimeoutMs(policy)`), so the timeout filter
     (`tick.ts ∈ [barOpenMs, barOpenMs + orderTimeoutMs]`) retains it.
   - **Restrict synthesis to `MARKETABLE_LIMIT_IOC` opens** (amendment A3). `simulateOrderFill`
     accepts any `IFillIntent`; the taker-touch tick must **not** be handed to `POST_ONLY_MAKER`
     (passive rest — different fill semantics). Guard the synthesis on the IOC policy and assert
     POST_ONLY is unreachable / untouched on the live open path.
2. **Normalize the live fill timestamp to event-time** (per amendment A2). After `sharedApplyFill`
   returns, the live streaming adapter overrides the result `tsMs` to `snapshot.ts + latencyMs`
   instead of the shared core's `signalBarOpenMs + 5m + latencyMs` (a next-bar value correct only for
   M7 replay). The shared core is **not** changed. This applies to **filled live opens**; verify the
   miss/null paths remain consistent.
3. **Replace the stale comment** with an accurate description: the live streaming adapter synthesizes
   one snapshot-derived executable-price tick because a marketable-limit-IOC crossing the live spread
   fills at the current quote, and re-stamps the fill to event-time; historical replay (M7) still
   passes recorded `tick_aggregates` and keeps next-bar timestamps. Remove the false "limit-vs-mark
   fallback" and "advances by `latencyMs` only" claims.
4. **Preserve historical/backtest conservatism.** Only `StreamingFillAdapter` (live event-time)
   changes. `HistoricalFillAdapter` and any backtest path keep their empty-tick / recorded-tick
   semantics and next-bar timestamps unchanged. The synthesized-tick and timestamp-override behaviour
   must be unreachable from backtest replay.
5. **Confirm the close/SL/TP side is unaffected.** `REDUCE_MARKET` already returns `false` from the
   detector (always fills); M24 does not touch that, and the per-position SL/TP registry
   (`applyIntraBarStop`) continues to fill exits.

**Out of scope:**
- Strategy activation (v2) — M25 (P1).
- Any stress/gate relaxation or slot/capital change — M25 (P2/P3).
- Shadow counterfactual fills — M26 (P4).
- Decision/position data-capture columns and the `book_snapshots` writer — M27 (P5).
- Depth-aware fill fidelity — fills stay `lowFidelity: true` (tier-floor slippage); depth-aware
  upgrade remains deferred per ADR 0019 / M7 known-approximation catalogue.
- Any change to the shared `missedFillDetector`/`fillSimulatorCore` contract (the fix is in the
  engine adapter that *calls* the shared core, not in the shared core itself).

## Boundary and fidelity semantics (lock before QA)

- **Live streaming path only.** The synthesized tick is constructed inside `StreamingFillAdapter`.
  No `packages/shared/` change. The shared miss-detector still returns `true` for a genuinely empty
  tick array — M24 simply stops the live adapter from handing it an empty array.
- **Spread-crossing IOC fills; non-crossing does not.** The synthesized executable-price point
  (LONG → ask, SHORT → bid, per A1) makes a marketable IOC that crosses fill, while a non-crossing
  inside-spread limit still misses because the detector's side-specific touch test fails against the
  executable price. Do **not** force `missed=false` unconditionally and do **not** feed the full
  bid/ask spread range — let the shared detector decide against a realistic executable price. (This
  keeps the detector as the single source of truth for fill confirmation.)
- **Determinism preserved.** No `Date.now()`/`Math.random()` introduced. The tick is built purely
  from `snapshot` fields already on the live event; the timestamp override (A2) uses `snapshot.ts`,
  not the wall clock; the HMAC seed path (`seed`) is unchanged. Two identical snapshots produce
  identical fills, including identical `tsMs`.
- **Fidelity stays low.** `lowFidelity: true` and tier-floor slippage are unchanged — M24 changes
  *whether* an open fills, not *at what slippage*.

## Change set

| Workspace        | Files (representative)                                                                                  | Item |
|------------------|--------------------------------------------------------------------------------------------------------|------|
| `apps/engine/`   | `src/paper-mode/service/StreamingFillAdapter.ts` (synthesize side-aware executable-price tick on IOC live path; override live `tsMs` to event-time; replace stale comment) | 1,2,3 |
| `apps/engine/`   | `src/paper-mode/service/PaperFillSimulator.ts` (extract the shared price-candidate helper consumed by `deriveReferencePrice` and the tick builder, if the candidate logic would otherwise be duplicated) | 1 |
| `apps/engine/` (tests) | paper fill-simulator / streaming-adapter specs — see expanded QA matrix in dispatch wave 2 | QA |
| `docs/` (scribe) | ADR 0015 §6 + ADR 0032 D15 footnote: live-streaming adapter supplies one quote-derived executable tick and re-stamps to event-time; empty-tick miss + next-bar timestamp remain for historical replay | A1/A2 |

No `packages/shared/` change (the shared miss-detector and fill-core contracts are unchanged — the
timestamp override happens in the adapter on the returned result). No dashboard change (no new reject
reason or funnel surface). No `apps/mcp` / `apps/agent` touch. No migration.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-engine-nestjs`**: implement the side-aware executable-price tick synthesis (A1),
   the event-time `tsMs` override (A2), the IOC-only synthesis guard (A3), and replace the stale
   comment in `StreamingFillAdapter`. Extract the shared price-candidate helper (M1) only if the
   fallback logic would otherwise be duplicated between `deriveReferencePrice` and the tick builder.
   Do **not** touch the shared core, the historical adapter, or `REDUCE_MARKET` handling. Confirm the
   synthesized tick and `tsMs` override are reachable **only** on the live streaming IOC-open path.
2. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - **Open now fills:** a gate-approved `MARKETABLE_LIMIT_IOC` open against a representative live
     snapshot produces `missed=false` with a non-zero `entryPrice` and a `positions`-eligible fill.
   - **Crossing semantics, both sides (A1):** LONG IOC at/above ask fills; LONG inside-spread (below
     ask, above bid) **misses**; SHORT IOC at/below bid fills; SHORT inside-spread (above bid, below
     ask) **misses**. Asserts M24 did not hard-code `missed=false` and did not use the spread range.
   - **Boundary-exact:** limit exactly equal to the executable price fills (detector's inclusive
     `<=`/`>=`).
   - **Partial-quote fallback (M2):** bid-missing/ask-present and vice versa; both missing with `mark`
     present (tick and reference price use the *same* candidate); a pathological mismatch defaults to
     **miss / no zero-price fill**, never a silent fill.
   - **Event-time timestamp (A2):** a filled live open has `tsMs === snapshot.ts + latencyMs` (not
     `+5m`). The historical path still produces next-bar `tsMs`.
   - **POST_ONLY boundary (A3):** the live open path never hands a taker-touch tick to
     `POST_ONLY_MAKER`; assert it is unreachable or gets no more optimistic semantics than the shared
     detector intends.
   - **Distinct miss reasons (M3):** no cached tick → `missedReason='no_tick_cached'`,
     `lowFidelity=false`; stale tick → adapter `null` / same sentinel; fresh tick but non-crossing →
     detector miss `missedReason='timeout'`, `lowFidelity=true`.
   - **Historical conservatism intact:** the backtest/historical empty-tick path still returns a
     missed fill (regression guard so a future refactor cannot leak the synthesized tick into replay).
     Run `M7FillEquivalence.regression.spec.ts` — golden tape unchanged.
   - **Integration through `PaperFillSimulator` (M1-Composer):** a non-stubbed OPEN flow
     (`translateToFillIntent` → adapter → ledger) yields `filled:true`, non-zero `fillPrice`, persisted
     row — not only an adapter-unit assertion.
   - **Determinism:** two identical snapshots + seed → byte-identical fill (entryPrice, slippage,
     `tsMs`).
   - **Exit unaffected:** `REDUCE_MARKET` close still fills (no regression on SL/TP).
3. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   **`bot-review-quant`**. The quant reviewer owns the fidelity argument: confirm the side-aware
   executable-price tick is the *correct* IOC fill model (fill at the crossed quote, tier-floor
   slippage, `lowFidelity` unchanged), is **not** an optimistic price invention, and that the
   inside-spread non-crossing case still misses (A1). Logic reviewer confirms the historical path
   cannot reach the synthesized-tick or `tsMs`-override branches, the three miss paths stay distinct,
   and the event-time timestamp is correct (A2). Cycle fix → re-review until zero blockers, zero
   highs, majority mediums.
4. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` paper-mode note (live fill path now synthesizes an executable-price
   tick and stamps fills at event-time), and the **ADR 0015 §6 / ADR 0032 D15 footnote** for the
   live-streaming exception. Record that M24 alone produces no visible live volume until M25 (P1/P2)
   lands — the fill fix is a prerequisite, proven by tests, not by live trades on a still-locked day.
   M24 does **not** fix the shadow counterfactual empty-tick gap (that is M26) — do not claim shadow
   fills are repaired. The post-deploy note distinguishes three live outcomes: **no gate approvals →
   no positions (M24 not exercised live)**, **approvals with missed fills → M24 failed**, **approvals
   with filled opens → M24 verified**.

Orchestrator verifies the actual diff after every wave and **explicitly confirms** (a) only the live
streaming adapter (and optionally the engine-local price-candidate helper) changed, (b) no
`packages/shared/` file was touched, (c) the stale comment was replaced with accurate text, (d) the
synthesized tick is a side-aware executable-price point (not the spread range) and is reachable only
for live `MARKETABLE_LIMIT_IOC` opens, and (e) the live `tsMs` override yields `snapshot.ts +
latencyMs` while the historical path keeps next-bar timestamps.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M24 is code-only and migration-free** — no schema change, no DB write, no `strategy_versions` write.
Picking up the change requires only an **engine restart**. No `-v`, no down/revert on the live soak.

**Backup rotation:** before the engine restart, take a routine `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`,
into the gitignored `backups/` folder). **Keep the 2 most recent `backup_` files; prune older ones.**
Show the user the dump path before restarting.

## Post-deploy steps

1. Take `pg_dump` before the engine restart (prune to 2-deep `backup_` retention).
2. **Engine restart only** (no migration).
3. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report any boot error before
   the scribe. Confirm the engine boots and stays running.
4. **Fill-path confirmation:** because M24 ships before M25, the day may still be locked and v1 may
   still skip — so live trades are **not** expected from M24 alone. The acceptance is the **test
   evidence** that a gate-approved open fills, plus an operational note that the first visible paper
   transactions appear once M25 (P1 v2 + P2 stress relax) lands. Do **not** relax the gate or switch
   strategy in this milestone to "see a trade" — that is M25's controlled change with its own review.

## Verification

- **Unit:** paper fill-simulator + streaming-adapter suites green; full `src/paper-mode` suite green;
  `src/backtest` suite green incl. `M7FillEquivalence.regression.spec.ts` (regression guard — no
  backtest fixture now fills an open it previously missed; the historical empty-tick path and next-bar
  timestamps are unchanged).
- **Open fills:** a crossing `MARKETABLE_LIMIT_IOC` open returns `missed=false`, non-zero entry price,
  `lowFidelity: true`, tier-floor slippage.
- **Inside-spread non-crossing still misses (both LONG and SHORT); historical empty-tick still
  misses** (detector remains the arbiter; A1 verified — spread range not used).
- **Event-time timestamp:** a filled live open has `tsMs === snapshot.ts + latencyMs`; historical
  fills keep next-bar `tsMs` (A2 verified).
- **POST_ONLY untouched:** the taker-touch tick is unreachable for `POST_ONLY_MAKER` on the live open
  path (A3).
- **Determinism:** identical snapshot + seed → identical fill (incl. `tsMs`).
- **Boot:** engine boots and stays **running** after restart (no DI/boot error).

## References

- Architect analysis (P0): [main-architector-paper-soak-fill-and-gate-analysis.md](../../wip/done/main-architector-paper-soak-fill-and-gate-analysis.md) §2.3, §5 P0, §6
- Independent reviews (2026-06-08, source of amendments A1–A3 / M1–M3):
  [composer](../../archive/independent-analysis/composer/M24-paper-open-fill-wiring-review.md),
  [gbt](../../archive/independent-analysis/gbt/M24-paper-open-fill-wiring-review.md),
  [gemini](../../archive/independent-analysis/gemini/M24-paper-open-fill-wiring-review.md)
- Missed-fill model: ADR 0015 §6
- Paper-mode fill simulator / determinism: ADR 0032
- Low-fidelity fills: ADR 0019
- Follow-on milestones: M25 (paper exploration enablement), M26 (shadow fills), M27 (data capture)

### Key source files

| Concern | Path |
|---|---|
| Streaming adapter (changes here) | `apps/engine/src/paper-mode/service/StreamingFillAdapter.ts` |
| Paper fills | `apps/engine/src/paper-mode/service/PaperFillSimulator.ts` |
| Missed-fill rule (unchanged) | `packages/shared/src/util/missedFillDetector.ts` |
| Fill core (unchanged) | `packages/shared/src/util/fillSimulatorCore.ts` |
| Historical adapter (unchanged) | `apps/engine/src/backtest/fill/HistoricalFillAdapter.ts` |
