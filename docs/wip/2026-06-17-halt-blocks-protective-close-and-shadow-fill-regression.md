# 2026-06-17 paper soak — halt freezes protective closes + shadow-fill regression

**Date:** 2026-06-17
**Author:** main session (trade analysis on operator request)
**Status:** WIP — defect analysis; **no fix landed**. Finding 1 is a trading-safety blocker.
**Scope:** Analysis of all 21 closed trades on 2026-06-17 (v3 active), verification that the
M37–M39 fixes hold in production data, and two newly-surfaced anomalies.

---

## Executive summary

Today produced **21 trades, net realized −24.71 USDT** (8 winners +51.5, 13 losers −76.2).
The day's result is dominated by **one position (#101 INJ, −21.36)** that exposes a
**critical trading-safety defect**:

> **Finding 1 (CRITICAL) — A global halt short-circuits *every* order intent, including
> risk-reducing protective closes.** When the `market_stress:multi` halt fired at 18:05, the
> open INJ long could not be closed by its time-stop (due 18:15) **or** by its stop-loss
> (price breached the SL at 18:xx). Both close intents were blocked by the halt gate and
> retried, unfilled, for **2h12m**, until an operator manually hit `/v1/control/resume` at
> 20:17. The position bled from entry 5.630 through its stop 5.439 down to 5.398 with **no
> working protective exit the entire time**. This is exactly the behaviour the operator
> flagged: a halt must stop *new* risk, it must **never** block *de-risking*.

Two further anomalies surfaced during verification:

- **Finding 2 (HIGH)** — Shadow `simulated_fill` population **collapsed to ~0/day from
  ~June 10 onward** (was 53–150/day Jun 6–9). M37 D1.6 and M39 W2 both claim to have repaired
  shadow counterfactual fills, and `STATUS.md` asserts "next bar walk producing non-degenerate
  realized PnL" — **the production data contradicts this**. 47 gate-allowed virtual opens today,
  **zero** populated fills.
- **Finding 3 (MEDIUM)** — Position **#38 (ZEC) is stuck in `pending_open` since 2026-06-15**
  (`qty=0`, `time_stop_at` 2026-06-15 14:20). A 2-day-old orphaned lifecycle row — M31-class
  zombie that the M31 fix does not cover (it never reached `open`).

M37–M39 fixes that **did** verify as holding are listed in the scorecard (§6).

---

## 1. Today's trades (2026-06-17, all v3)

| id | symbol | side | exit | pnl | hold min | note |
|----|--------|------|------|-----|----------|------|
| 81 | MU | long | time_stop | −1.21 | 15.0 | |
| 82 | JTO | short | time_stop | −7.11 | 15.0 | |
| 83 | SPX | long | take_profit | **+11.35** | 3.0 | clean TP, MFE 0.0217 |
| 84 | LAB | long | time_stop | −14.10 | 15.0 | MAE −0.0302 |
| 85 | DRAM | long | time_stop | −0.83 | 15.0 | |
| 86 | MU | short | stop_loss | −0.47 | 0.4 | SL fired fast, fine |
| 87 | INJ | short | time_stop | −1.03 | **21.7** | **time-stop breach (+6.7m)** |
| 88 | TAO | long | time_stop | −3.70 | 15.0 | |
| 89 | XPL | long | take_profit | **+13.60** | 7.6 | clean TP, MFE 0.0263 |
| 90 | ONDO | long | time_stop | +0.94 | 15.0 | |
| 91 | LIT | long | time_stop | +5.91 | 15.0 | |
| 92 | PLAY | long | time_stop | +13.57 | 15.0 | MFE 0.0258 |
| 93 | CRCL | long | time_stop | −4.83 | 15.0 | |
| 94 | DRAM | short | time_stop | −5.18 | 15.0 | |
| 95 | SOXL | short | stop_loss | −13.59 | 8.1 | SL fired, fine |
| 96 | LIT | long | time_stop | −2.30 | 15.0 | |
| 97 | TIA | long | time_stop | +0.59 | 15.0 | |
| 98 | HYPE | long | time_stop | +4.26 | 15.0 | |
| 99 | XPL | long | time_stop | −0.46 | 15.0 | |
| 100 | STG | short | time_stop | +1.25 | 15.0 | |
| 101 | INJ | long | time_stop | **−21.36** | **137.0** | **halt-frozen (Finding 1)** |

Net: **−24.71 USDT** (matches `risk_state` for 2026-06-17, `trades_count=21`).
Excluding #101 the day is roughly flat (≈ −3.4). Two positions exceeded the 15-minute
time-stop deadline: **#87 (21.7m)** and **#101 (137m)** — both correlate with the halt window
(see §2), confirming the same root cause at two magnitudes.

---

## 2. Finding 1 (CRITICAL) — halt short-circuits protective closes

### Timeline (UTC, position #101 INJ/USDT long, entry 5.630433, qty ≈ 90.2, notional ≈ 508)

| Time | Event |
|------|-------|
| 18:00:01 | Position #101 opens. `time_stop_at = 18:15:00`, `protective_order_type = exchange_side`, SL 5.439, TP 5.696. Local monitor armed (paper keeps it armed — ADR 0008 §7). |
| 18:05:01 | `HaltFlagService: Trading halted: market_stress:multi` (auto breadth/market-wide stress halt). |
| 18:15:00 | `PositionTimeStopEnforcer` emits time-stop close for #101 → `ExecutionService: halt flag set (market_stress:multi); short-circuiting eventId=time-stop-enforcer-101`. Intent expires `reason=ORDER_INTENT_EXPIRED_REASON_HALTED`. **Retried every ~1s for the next 2 hours, every attempt short-circuited.** |
| ~18:1x | `LocalProtectiveMonitor: BREACH positionId=101 kind=stop_loss markPrice=5.439 … markPrice=5.436 — close intent emitted through gate` → `halt flag set; short-circuiting eventId=local-monitor-breach-101-stop_loss` → `breach intent for positionId=101 expired (reason=halted) — released close slot`. **The stop-loss could not execute either.** |
| 20:17:01 | Operator **manually** `POST /v1/control/resume` → `Trading resumed`. The pending time-stop close immediately fills: `position 101 INJ CLOSED exitReason=time_stop realizedPnl=-21.35569853 exit=5.398085`. |

The `market_stress:multi` halt **did not auto-resume** for 2h12m; it required a manual operator
resume. Whether the stress condition genuinely persisted or the M23 breadth auto-resume failed
to clear is a secondary question — **the position should never have been at the mercy of either.**

### Root cause

`apps/engine/src/execution/service/ExecutionService.ts:163` — `handleApproved` short-circuits
**any** approved intent when `haltFlag.isHalted()`, with no distinction between risk-*increasing*
(OPEN/ADD) and risk-*reducing* (REDUCE/CLOSE/FLATTEN) intents:

```ts
if (this.haltFlag.isHalted()) {
    this.logger.warn(`halt flag set (...); short-circuiting eventId=${event.intent.eventId}`);
    this.releaseReservationSafely(event.reservationId);
    this.events.emit(ORDER_INTENT_EXPIRED_EVENT, { ..., reason: ORDER_INTENT_EXPIRED_REASON_HALTED });
    return;
}
await this.executeLive(event, plan, nowMs);
```

This blocks the time-stop enforcer (ADR 0011 last-line-of-defense) **and** the local protective
monitor's SL breach close. The gate semantics are inverted from the safety intent: a halt is
supposed to be a brake on *opening exposure*, but here it freezes *all* exposure in place —
including positions that are actively breaching their stop during a market-stress event, which
is the worst possible moment to suspend protective exits.

Note also the M38 D2 fill-acceptance design routes a de-risking `FLATTEN` through
`riskGate.evaluate` as an "auto-approved de-risk" — but it would hit this same halt
short-circuit downstream, so even the M38 unwind path is unsafe under a concurrent halt.

### Impact

- Direct: #101 closed at 5.398 instead of ~5.439 (its stop) → ≈ **−3.7 USDT extra loss**, and
  ≈ 2 hours of unmonitored tail risk on a ~$508 notional during declared market stress. A larger
  adverse move in that window would have been uncapped.
- Systemic: **the kill-switch / halt is currently anti-safety for open positions.** Any halt
  (manual or auto) freezes every open position's stop-loss and time-stop until resume.

### Recommended fix (for a milestone — do not hot-patch)

**Primary (correct, minimal):** exempt risk-reducing intents from the halt short-circuit. The
classifier already exists — `ExecutionService.isOpenOrAddIntent(action)` (used at `:210`). Gate
only OPEN/ADD on halt; let REDUCE/CLOSE/FLATTEN through:

```ts
if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(event.intent.intentAction)) {
    // short-circuit opens/adds only
}
```

This guarantees the time-stop enforcer and local protective monitor can always close, and that
M38's FLATTEN unwind survives a concurrent halt. (`OrderIntentActionEnum`: `OPEN`, `ADD`,
`REDUCE`, `CLOSE`, `FLATTEN`.)

**Policy option (operator's "do something with open positions"):** on a *market-stress* halt,
additionally **flatten all open positions** at halt time rather than merely permitting their
existing exits. This is the more conservative reading and fits the project's survival-first
philosophy, but it changes behaviour (forced exit vs. letting the stop/time-stop run) and should
be an explicit ADR decision. The primary fix above is a prerequisite either way — flatten intents
would themselves be blocked by the current gate.

**Out of scope but related:** investigate why `market_stress:multi` did not auto-resume for
2h12m (M23 `aee6e70` breadth auto-resume). A halt that can only be cleared manually compounds
Finding 1.

---

## 3. Finding 2 (HIGH) — shadow `simulated_fill` collapsed (~June 10 →)

M37 D1.6 ("Shadow fill-simulator repair") and M39 W2 ("deferred next-bar exit walk producing
non-degenerate realized PnL") both claim shadow counterfactual fills are now populated.
`STATUS.md` line 9 asserts the soak is "producing non-degenerate realized PnL". Production data
disagrees:

`shadow_decisions` fill population by day:

| date | total rows | rows with `simulated_fill` | gate-allowed virtual opens |
|------|-----------:|---------------------------:|---------------------------:|
| 2026-06-06 | 354 | 97 | 104 |
| 2026-06-07 | 573 | 150 | 164 |
| 2026-06-08 | 468 | 96 | 106 |
| 2026-06-09 | 528 | 53 | 56 |
| 2026-06-10 | 525 | **0** | 0 |
| 2026-06-11 | 528 | 3 | 3 |
| 2026-06-12 | 303 | **0** | 0 |
| 2026-06-13 | 480 | **0** | 0 |
| 2026-06-14 | 408 | **0** | 11 |
| 2026-06-15 | 618 | **0** | 73 |
| 2026-06-16 | 543 | 1 | 25 |
| **2026-06-17** | **552** | **0** | **47** |

Today, v2 had **47 gate-allowed virtual opens and 0 populated `simulated_fill`**; v4 had 29
opens (all gate-rejected); v1 skipped all 184. So the shadow ledger is recording decisions but
**not** the counterfactual realized PnL the comparison/promotion gate depends on.

This is the **same class of defect M37/M39 were chartered to fix, recurring in production.**
The most likely mechanism: M39's deferred next-bar walk queues pending walks **in memory**
(`IPendingDeferredWalk`) and only writes `simulated_fill` on a *subsequent* `runShadows` call
once next-bar `tick_aggregates` exist. If the engine restarts between bar N and N+1 (M37 and
M39 both deployed in this window, plus the 11h-uptime restart), the in-memory queue is dropped
and the fill is never written. The walk path needs durability (persist pending walks) or a
backfill sweep — and the M37/M39 "fixed" claim in `milestone-log` + `STATUS.md` should be
re-qualified until production shows non-zero fills. **Recommend the scribe correct STATUS.md
once confirmed.**

---

## 4. Finding 3 (MEDIUM) — zombie `pending_open` #38 (ZEC) since 2026-06-15

`positions_id=38`, ZEC/USDT short, `state=pending_open`, `qty=0`, `entry_notional=523.96`,
`opened_at=2026-06-15 14:05`, `time_stop_at=2026-06-15 14:20`, never transitioned to `open`,
never closed. It is the only non-terminal row in the table (all 99 others are `closed`).

This is **not** covered by the M31 zombie fix (which handles `qty=0` rows mislabeled as `open`
and the close-path lifecycle). #38 never reached `open` — the `pending_open → open`
(`protective.attached`) transition never fired, so it sits as an orphaned reservation row for
2 days. It does not appear in `findLiveRisk()` (no exposure leak observed — `risk_state` shows
`open_exposure=0`), but it is a lifecycle leak: a `pending_open` with no timeout/cleanup path.
Recommend a boot-time/periodic sweep that fails orphaned `pending_open` rows older than a small
multiple of the open timeout to a terminal state.

---

## 5. Finding 4 (LOW / monitor) — TP-with-negative-PnL: fixed today, recurred 6/16

M37 Problem 3 flagged "TP exits with negative realized_pnl and 0 MFE" as a trade-record
integrity defect. Status:

- **2026-06-17: clean.** Both TP exits (#83 SPX +11.35, #89 XPL +13.60) have positive PnL,
  non-zero MFE, multi-minute holds.
- **2026-06-16: 3 recurrences** — #68 ETH (−0.95, MFE 0.0000, 45s), #70 BASED (−0.65, MFE
  0.0000, 31s), #72 STG (−4.57, MFE 0.0154). Sub-minute "take_profit" exits at a price worse
  than entry.

The 6/16 cases likely predate the M38 D1 TP-rebase deploy landing mid-day; the absence on 6/17
suggests the M38 momentum-TP-rebase-to-fill-price fix is working. **Monitor for 2–3 more days**
to confirm zero recurrence before declaring it closed.

---

## 6. M37–M39 verification scorecard

| Milestone claim | Verified in prod data? | Evidence |
|-----------------|------------------------|----------|
| M38 D2 — fill-acceptance drift guard wired & evaluating | ✅ Yes | `ExecutionService: fill-acceptance drift positionId=101 driftPct=n/a shouldReject=false reason=none` — guard runs on opens. |
| M38 D1 — momentum TP rebased to fill price (no instant-TP) | ✅ Likely | No negative-PnL TP on 6/17 (was 3 on 6/16); §5. Monitor. |
| M37 P3 — TP-with-negative-PnL integrity | ⚠️ Partial | Clean 6/17, recurred 6/16; §5. |
| M33/M38 — live time-stop enforcement exists | ✅ Yes (enforcer fires) | `PositionTimeStopEnforcer` emits closes for #96/#97/#101. **But** Finding 1: closes are blocked by halt. |
| Exit-enforcement: positions close at/near their deadline | ❌ **No** | #101 closed 137m past deadline, #87 22m — both during/after the halt. The enforcer is correct; the **gate** defeats it (Finding 1). |
| M37 D1.6 / M39 W2 — shadow counterfactual fills populated, non-degenerate realized PnL | ❌ **No (regressed)** | Finding 2: 0 fills/day since ~Jun 10 despite gate-allowed opens; contradicts STATUS.md. |
| M39 W1 — virtual slot freed each event (opens accrue) | ✅ Partial | Opens do accrue (47 v2 opens today vs the ≈1/day starvation M39 described) — slot-free worked; fill *value* did not (Finding 2). |

---

## 7. Recommended next actions (priority order)

1. **Finding 1 (CRITICAL, go-live blocker):** milestone to exempt REDUCE/CLOSE/FLATTEN from the
   halt short-circuit at `ExecutionService.ts:163`, plus an ADR decision on whether a
   market-stress halt should additionally flatten open positions. Pair with the standard dispatch
   waves (architect on the gate-contract touch, QA adversarial halt-during-open-position tests,
   full reviewer wave). Add a regression test: *open position + halt + time-stop/SL breach →
   close still executes.*
2. **Finding 2 (HIGH):** investigate the deferred-walk durability gap; persist pending walks or
   add a backfill sweep; re-qualify the M37/M39 "fixed" claims and STATUS.md until prod shows
   non-zero shadow fills.
3. **Finding 4 (MEDIUM):** investigate `market_stress:multi` not auto-resuming for 2h12m (M23).
4. **Finding 3 (MEDIUM):** orphaned-`pending_open` cleanup sweep (#38 ZEC).

No code changed as part of this analysis.
