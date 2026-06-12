# Independent Review — M33 Live Exit Enforcement

**Plan reviewed:** `docs/plans/M33-live-exit-enforcement.md`  
**Source defect doc:** `docs/wip/live-exit-enforcement-gap.md`  
**Codebase snapshot:** 2026-06-12 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M33 is a **survival-class fix** for a **code-verified, production-soak defect**: positions open correctly but never close when SL/TP do not fire and the local monitor is disarmed after `exchange_side` attach in paper. The WIP evidence (PYTH #4, OPN #5 — real `qty > 0`, past `time_stop_at`, zero transactions) matches the diagnosed root causes. The plan correctly separates three independent bugs, routes every new close through the existing gate → executor seam, and refuses migration/shared-package scope creep.

The **`SharedCloseCoordinator`** is the right architectural move: it fixes the asymmetric `breachInFlight` gap (monitor checked enforcer, but not vice versa) and generalizes dedup to all gate-routed closes. The **time-stop-WINS** collision ordering is verified against `BacktestRunnerService.checkPositionExit` — the prior SL/TP-priority draft was indeed inverted.

**Assessment:** **Approve with amendments** — dispatch after locking four implementation details below. The wave split (2a registry + paper guard + cashflow, then 2b enforcer + SL/TP persistence) is correct. Do not merge 2b until D-TS-5-adv and registry release-path tests pass in 2a.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis (3 sub-problems) | A+ | WIP facts + source lines verified; distinct from M31 zombies. |
| Backtest parity (decision ordering) | A | `shouldHitTimeStop` returns before `simulateIntrabarStop`; plan matches. |
| Backtest parity (fill price) | A- | ADR 0015 §4.6 amendment correctly bounds divergence; decision timing has a minor bar-vs-tick nuance (see Amendments). |
| `SharedCloseCoordinator` design | A | Symmetric dedup; resolves BLOCKER L1. Release paths need widening (see Amendments). |
| Paper disarm guard (Fix 2) | A | One guard at `applyProtectiveAttachResult:1140`; minimal and correct. |
| SL/TP persistence + boot re-arm (Task 5) | A- | Columns exist (`PositionEntity.ts:48-52`); phase 4c widening is necessary for restart survival. |
| Entry `cashflow` (Fix 3) | A+ | One-line parity with reduce path (`ExecutionService.ts:401-403` vs `:1054`). |
| Event ordering (`prependListener`) | B+ | Correct mechanism for nestjs-event-emitter; pin with D-TS-5-adv; document fragility. |
| FLATTEN / kill-switch wiring (Task 3) | C+ | **Real FLATTEN emit site is still a logging stub** — see Amendments. |
| Test matrix | A | D-TS / D-FL / D-PP / D-CF series is adversarial and complete. |
| Scope / dispatch | A | 2a/2b split, no migration, deferred MEDIUM tech-debt called out honestly. |
| Post-deploy checklist | A | pg_dump ritual, stuck-row flatten, monitoring queries are actionable. |

**Bottom line:** **Yes, implement M33.** The plan closes a genuine go-live blocker. **Amend Task 3** to enumerate all real CLOSE emit sites today (monitor, enforcer, reconciliation flatten) and treat kill-switch `LoggingFlattenCoordinator` as out-of-scope for D-FL until W6 lands. **Amend registry release** to cover non-`halted` `ORDER_INTENT_EXPIRED_EVENT` and post-approval execution failures. **Add a lightweight deadline fast-path** (optional but cheap) before deferring the full index.

---

## Verified Current State

### Sub-problem 1 — No time-stop enforcer (confirmed)

`LocalProtectiveMonitor` evaluates SL/TP only (`evaluateBreach`, no time-stop branch). `ReconciliationService` is drift-only on a 30s interval. `time_stop_at` is written at open (`ExecutionService.ts:1107`) but never read back for enforcement.

Backtest reference — time-stop checked first and returns before intrabar SL/TP:

```700:708:apps/engine/src/backtest/service/BacktestRunnerService.ts
        if (this.shouldHitTimeStop(position, bar)) {
            // ...
            await this.closePosition(ctx, position, bar, 'time_stop', new Money(bar.open), bar.openTimeMs - CANDLE_5M_INTERVAL_MS, data, ticks);

            return;
        }
```

Live enforcer design (event-time compare, gate-routed CLOSE) is the correct analogue.

### Sub-problem 2 — Paper + `exchange_side` exit vacuum (confirmed)

After successful exchange-side attach, the monitor is always disarmed — no `EXCHANGE_ENV` branch:

```1137:1141:apps/engine/src/execution/service/ExecutionService.ts
        // Exchange-side success: disarm the local monitor. The local layer stands down for
        // this position; the exchange's STOP_MARKET / TAKE_PROFIT_MARKET orders are now the
        // first line of defense (ADR 0008 §2).
        this.localProtectiveMonitor.disarm(positionRow.id);
        this.logger.log(`position ${positionRow.id} ${positionRow.symbol} protected EXCHANGE_SIDE (SL+TP at mark price); local monitor disarmed`);
```

Boot phase 4c re-arms **only** `LOCAL_FALLBACK` rows; `exchange_side` rows skip re-arm:

```270:272:apps/engine/src/bootstrap/service/EngineBootstrapService.ts
            if (position.protectiveOrderType !== ProtectiveOrderTypeEnum.LOCAL_FALLBACK) {
                continue; // EXCHANGE_SIDE is alive — monitor stays disarmed
            }
```

In paper there is no exchange matching engine — disarm creates the vacuum the WIP describes.

### Sub-problem 3 — Entry `cashflow` null (confirmed)

`recordEntryTransaction` omits `cashflow`; reduce path sets `new Money(0)` for non-close types:

```1054:1063:apps/engine/src/execution/service/ExecutionService.ts
        await this.transactions.recordTerminal({
            positionId,
            type: this.intentActionToTransactionType(event.intent.intentAction),
            side: event.intent.tradeSide,
            price: fillSummary.avgFillPrice,
            qty: fillSummary.filledQty,
            fee: fillSummary.feeTotal,
            clientOrderId: submitResult.clientOrderId,
            exchangeOrderId: submitResult.exchangeOrderId,
        });
```

### `findLiveRisk()` includes `CLOSING` — plan HIGH L1 is correct

```43:44:apps/engine/src/position/repository/PositionRepository.ts
    async findLiveRisk(): Promise<PositionEntity[]> {
        return this.repository.createQueryBuilder('p').where('p.state != :closed', { closed: PositionStateEnum.CLOSED }).andWhere('p.qty > 0').getMany();
```

A row in `CLOSING` with `qty > 0` **is** returned. The enforcer's explicit `state ∈ {OPEN, PENDING_OPEN}` filter is mandatory — the plan is right not to rely on `findLiveRisk()` alone.

### Asymmetric dedup today — BLOCKER L1 is real

`LocalProtectiveMonitor` has `breachInFlight` but only guards its own re-emits (`:271`). There is no cross-producer guard if a time-stop enforcer is added without `SharedCloseCoordinator`. Two closes with different `eventId`s would both reach the executor.

### SL/TP columns exist — migration-free Task 5 holds

`positions.stop_loss_price` / `take_profit_price` are nullable numerics on `PositionEntity` (`:48-52`). They are armed in-memory at open (`ExecutionService.ts:909`) but **not persisted** on the `exchange_side` success path today — restart re-arm gap (HIGH L3) is real.

---

## Strengths

1. **Correct survival framing.** "No position held past its declared exit" is the right bar; adversarial QA on double-close and paper/live parity is appropriate.

2. **`SharedCloseCoordinator` over per-producer flags.** Single `tryAcquire` substrate for time-stop, SL/TP, and FLATTEN is simpler and total. Relocating monitor `breachInFlight` into the shared registry avoids two parallel dedup mechanisms.

3. **Time-stop-WINS matches locked backtest reference.** The plan explicitly removes the inverted SL/TP-priority draft. Structural enforcement via acquire-order + monitor skip is cleaner than reason-priority logic in two handlers.

4. **Event-time determinism.** Comparing `time_stop_at` to `IPriceUpdateEvent.timestampMs` (never `Date.now()`) preserves M7 replay contract for **decisions**. Honest ADR 0015 §4.6 amendment on fill-price divergence (mark + taker slippage vs slippage-free `bar.open`) is quant-correct.

5. **Fix 2 minimalism.** "Do not disarm in paper" reuses the existing `evaluateBreach` loop — no second simulation path. Task 5 (persist SL/TP + widen phase 4c) correctly pulls restart survival into scope instead of deferring a go-live gap.

6. **Fix 3 discipline.** One line, no arm/attach reorder — matches ADR 0008 §2 and M31 lessons.

7. **Test matrix.** D-TS-5-adv (collision), D-TS-6-adv (`CLOSING` exclusion), D-TS-9-adv (qty re-read), D-TS-14-adv (post-restart), D-PP-6 (paper restart re-arm) cover the failure modes that would re-create stuck positions.

8. **Honest deferred scope.** Stale-feed symbols (MEDIUM Q2) and reconciliation-tick fallback are called out in success criteria — avoids false "100% deadline enforcement" claims.

---

## Risks & Amendments

### Amendment 1 — Registry release paths are incomplete (MEDIUM → address in Task 3)

The plan releases the coordinator slot on: gate reject, `POSITION_STATE_TRANSITIONED → CLOSED`, and `ORDER_INTENT_EXPIRED` with `reason='halted'`.

**Gap:** The monitor today has the same narrow recovery — it only clears `breachInFlight` on `halted` expiry (`LocalProtectiveMonitor.ts:207-227`). Other expiry reasons exist:

- `dry_run` (`ExecutionService.ts:172`)
- Generic expiry with `state` only (`:1172`, no `reason`)

If a close is gate-approved but execution fails (uncaught throw in `onOrderIntentApproved`, `:113-116`), **no** `ORDER_INTENT_EXPIRED` fires and the in-flight flag can stick — position becomes uncloseable by monitor or enforcer.

**Recommendation:** In Task 3, wire `SharedCloseCoordinator.release(positionId)` on:

1. All `ORDER_INTENT_EXPIRED_EVENT` variants whose `eventId` matches enforcer or monitor prefixes (not only `halted`).
2. Consider `POSITION_STATE_TRANSITIONED → CLOSING` as a release trigger **only if** the transition was initiated by a different producer — otherwise keep the slot until `CLOSED` or explicit failure. At minimum, add **D-TS-15-adv**: approved close → execution throw → registry released on next recovery event or explicit timeout.

This is not scope creep — it is the same ADR 0011 §4 "last line of defense" contract the monitor already claims.

### Amendment 2 — FLATTEN emit site is still a stub (HIGH for D-FL tests)

`LoggingFlattenCoordinator` only logs — it does **not** emit CLOSE intents:

```36:42:apps/engine/src/control/interface/IFlattenCoordinator.ts
    async flattenAllOpen(request: IFlattenRequest): Promise<void> {
        // Visible breadcrumb. The real W6 implementation reads open positions,
        // synthesises a CLOSE `IOrderIntent` per row, and feeds each through
        // `RiskGateService.evaluate(...)`. Until W6 lands, the audit row +
        // alert are the durable evidence that a flatten was requested.
        this.logger.warn(`flatten.requested reason=${request.reason} correlation=${request.correlationEventId ?? 'null'}`);
    }
```

**Real FLATTEN-like CLOSE emit today:** `ReconciliationService.flattenAdoptedForeignPosition` → `ORDER_INTENT_APPROVED_EVENT` (`:814`).

**Recommendation:**

- Task 3: wire `tryAcquire` at **ReconciliationService** flatten emit (concrete site) **and** document that kill-switch flatten coordinator integration is deferred until W6 replaces `LoggingFlattenCoordinator`.
- D-FL-1 / D-FL-2: test against the reconciliation flatten path (or a test double implementing `IFlattenCoordinator` with real gate-routed emits). Do not block M33 on W6, but do not claim kill-switch flatten is production-safe until then.

### Amendment 3 — Decision timing: bar boundary vs first tick (LOW, document only)

Backtest fires time-stop when `bar.openTimeMs >= timeStopAtMs` at the **5m bar open** with fill at `bar.open`. Live enforcer fires on the **first `price.update` tick** with `timestampMs >= timeStopAtMs`.

For deadlines that fall mid-bar, live may close **earlier within the bar** than backtest (which waits for the next bar whose `openTimeMs` crosses the deadline). The plan correctly documents fill-price divergence; add one sentence to ADR 0015 §4.6 that **decision timestamp** may also lead backtest by up to one bar interval in edge cases. Acceptable for soak gate if quant reviewer signs off — fail direction is earlier exit (more conservative), not missed exit.

### Amendment 4 — Optional deadline fast-path (LOW, cheap win)

Per-tick `findLiveRisk()` on every `price.update` is acceptable at the 3-slot cap but noisy on the hot path (many symbols × many ticks). Before deferring the full index (MEDIUM L1), consider:

- In-memory `earliestTimeStopMs` (or per-symbol map) updated at open/close.
- Skip DB read when `event.timestampMs < earliestTimeStopMs`.

One small field on the enforcer — not the full index — cuts DB load without changing semantics. Optional for M33; file as "nice to have" if wave 2b is time-constrained.

### Amendment 5 — `prependListener` ordering (pin in tests)

Using `@OnEvent(PRICE_UPDATE_EVENT, { prependListener: true })` on the enforcer is the right fix given non-deterministic provider init order. **D-TS-5-adv must assert listener order**, not just collision outcome — e.g. spy on acquire call order between enforcer and monitor handlers.

Document in ADR 0011 §9: if another handler later uses `prependListener: true` on the same event, ordering becomes ambiguous — prefer a single orchestrator or explicit event chain if that happens.

### Amendment 6 — Bootstrap re-arm qty (verified OK, add test assertion)

`phase4cRearmLocalMonitor` arms SL/TP **prices** only; fresh qty is read in `handleBreach` via `findById` (`LocalProtectiveMonitor.ts:278`). Partial reduces do not require re-arming qty on the armed struct. **D-PP-6** should still assert that a post-restart breach close uses **current** row qty, not original open qty (extends D-TS-9 pattern to boot path).

---

## Minor Notes (no blockers)

| Item | Note |
|------|------|
| `armedAtMs: Date.now()` in monitor `arm()` | Pre-existing; unrelated to M33. Enforcer correctly uses event time. |
| DI cycle risk | Enforcer + monitor + coordinator + `forwardRef(RiskGateService)` — boot smoke in post-deploy checklist is sufficient. |
| `buildDeRiskCloseIntent` extraction | Prefer shared helper if file cap allows; duplication with cross-reference is acceptable. |
| Operator flatten of PYTH/OPN | Correct one-time deploy step; not a substitute for code fix. |
| `ExitReasonEnum.TIME_STOP` | Plan grep confirms usage in backtest; no shared dispatch expected. |

---

## Dispatch Recommendations

1. **Wave 2a (Tasks 1–3):** Land cashflow, paper disarm guard, `SharedCloseCoordinator` + monitor migration + reconciliation flatten wiring. Run paired tests including registry release amendments.

2. **Mini-review between waves:** Logic reviewer confirms no CLOSE bypasses gate; security confirms registry cannot fire on `CLOSING`/`closed` rows.

3. **Wave 2b (Tasks 4–5):** Enforcer with `prependListener: true`; SL/TP persist + phase 4c paper widening. Integration test D-TS E2E (paper open → time_stop close with `exit_reason='time_stop'`).

4. **Quant review focus:** (a) time-stop-WINS ordering vs backtest; (b) ADR 0015 §4.6 fill + decision timing bounds; (c) no double-close across producers.

5. **Scribe:** Close WIP doc to `docs/wip/done/`; amend ADRs 0011 §9, 0008 §7, 0012 §5, 0015 §4.6; file MEDIUM L1/L2 tech-debt as plan specifies.

---

## Conclusion

M33 is **well-researched, correctly scoped, and addresses a real production soak failure** that blocks trustworthy paper/live operation. The three-fix decomposition is sound; `SharedCloseCoordinator` is the key design improvement over the prior draft. **Approve with amendments** on registry release completeness, FLATTEN site honesty (reconciliation vs kill-switch stub), and optional deadline fast-path. With those locked, the plan is ready for Wave 2a dispatch.
