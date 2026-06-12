# Independent Review - M24 Paper Open-Fill Wiring

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/archive/M24-paper-open-fill-wiring.md`  
**Date:** 2026-06-08

## Verdict

I approve the direction of M24. The diagnosis is correct: live paper opens are translated to
`MARKETABLE_LIMIT_IOC`, but `StreamingFillAdapter` passes an empty tick array into the shared fill
core, and `missedFillDetector` treats empty ticks for limit policies as an unconditional miss. A
snapshot-derived tick in the live streaming adapter is the right narrow fix, and keeping
`packages/shared/`, the historical adapter, strategy code, and risk-gate behavior unchanged is the
right boundary.

I would not dispatch M24 as-is. The plan's proposed tick shape can accidentally turn inside-spread
non-crossing limits into fills, and the plan repeats an existing timestamp misunderstanding in
`StreamingFillAdapter`: `applyFill` does not return `snapshot.ts + latencyMs`; it returns
`signalBarOpenMs + 5m + latencyMs`. Both issues are fixable inside the engine adapter/test plan, but
they need to be locked before implementation.

## Must-Fix Before Dispatch

### H1 - Synthesizing `high=ask` and `low=bid` can fill non-crossing inside-spread orders

The plan says to synthesize a tick such as:

```text
[{ high: <ask|last>, low: <bid|last>, ts: snapshot.ts }]
```

That is unsafe with the current shared detector semantics:

```49:59:packages/shared/src/util/missedFillDetector.ts
    if (ticks.length === 0) {
        return true; // no ticks -> cannot confirm fill -> missed
    }
```

```84:93:packages/shared/src/util/missedFillDetector.ts
    if (side === 'long') {
        // LONG: ask comes down to limitPrice -> tick.low <= limitPrice
        return ticks.some((tick) => isLessThanOrEqual(parseDecimal(tick.low), limit));
    }

    // SHORT: bid comes up to limitPrice -> tick.high >= limitPrice
    return ticks.some((tick) => isGreaterThanOrEqual(parseDecimal(tick.high), limit));
```

For a long order, the detector interprets `tick.low` as the executable ask path. If the adapter sets
`low=bid`, then a long limit inside the spread can falsely fill:

```text
bid=100, ask=101, long limit=100.5
real IOC outcome: does not cross ask -> miss
planned synthetic low=100 -> 100 <= 100.5 -> fills incorrectly
```

The symmetric short case has the same bug if `high=ask`:

```text
bid=100, ask=101, short limit=100.5
real IOC outcome: does not cross bid -> miss
planned synthetic high=101 -> 101 >= 100.5 -> fills incorrectly
```

Required plan change:

- Build the synthetic tick from the **side-specific executable touch price**, not the whole bid/ask
  spread range.
- For long opens, the detector's `low` must represent the ask-side executable price. For short opens,
  `high` must represent the bid-side executable price.
- The safest one-tick shape is side-aware and point-like: long open uses `high=ask, low=ask`; short
  open uses `high=bid, low=bid`, with deterministic fallback mirroring `deriveReferencePrice`.
- If a fallback uses `mark` or `last` because the side-specific quote is unavailable, the synthetic
  tick must use the same fallback value so the reference price and touch evidence remain consistent.

Required tests:

- Long IOC at or above ask fills.
- Long IOC below ask but above bid misses.
- Short IOC at or below bid fills.
- Short IOC above bid but below ask misses.
- Missing ask/bid fallback is deterministic and cannot produce a zero-price fill.

This is the main correctness edge. Without it, M24 can replace "everything misses" with "some orders
fill even though they did not cross the live spread."

### H2 - Live event-time fill timestamp is still 5 minutes late

The plan repeats the existing streaming-adapter comment that `computeFillTimestamp` advances by
latency only:

```223:231:apps/engine/src/paper-mode/service/StreamingFillAdapter.ts
        // Signal-bar open is effectively "now" for live event-time; the
        // shared core's `computeFillTimestamp` advances by `latencyMs` only.
        const signalBarOpenMs = snapshot.ts;

        return sharedApplyFill(snapshot, intent, coinTier, tierSlippageParams, seed, [], signalBarOpenMs, orderTimeoutMs, latencyMs);
```

But the shared core currently does this:

```148:151:packages/shared/src/util/fillSimulatorCore.ts
    const CANDLE_5M_INTERVAL_MS = 5 * 60 * 1000;
    const nextBarOpenMs = signalBarOpenMs + CANDLE_5M_INTERVAL_MS;
    return nextBarOpenMs + latencyMs;
```

So a live paper open at `snapshot.ts` is recorded at `snapshot.ts + 5m + latencyMs`, not at the
current quote time. M24 is already touching this exact call site and replacing a stale comment; the
timestamp contract should not stay ambiguous.

Required plan change:

- Decide explicitly whether M24 preserves the existing 5-minute-late live timestamp as a deferred
  known issue, or normalizes the live streaming result to `snapshot.ts + PAPER_FILL_LATENCY_MS`.
- My recommendation: fix it in the streaming adapter, not the shared core. The shared core's
  next-bar timestamp preserves M7 backtest semantics; the live adapter can deterministically adjust
  the returned `tsMs` after `sharedApplyFill` for the event-time path.
- Add an assertion to M24 QA: a filled live streaming open has `tsMs === snapshot.ts + latencyMs`.

This is not just cosmetic. Timestamps drive transaction ordering, position opened-at times, and any
later analysis that joins fills back to market data. Keeping a hidden +5m shift will contaminate the
first post-M24 paper outcome dataset.

### H3 - `POST_ONLY_MAKER` semantics should be explicitly out of scope or tested separately

M24 is motivated by opens that `PaperFillSimulator` currently maps to `MARKETABLE_LIMIT_IOC`, but
`StreamingFillAdapter.simulateOrderFill` accepts any `IFillIntent` and resolves timeouts for both
`MARKETABLE_LIMIT_IOC` and `POST_ONLY_MAKER`.

If the helper that creates the synthetic tick is policy-agnostic, it may accidentally give
post-only-maker orders the same taker-touch evidence as an IOC. The plan says POST_ONLY is out of the
current router path indirectly, but the implementation prompt should be stricter.

Required plan change:

- State that the synthesized live tick is required for `MARKETABLE_LIMIT_IOC` opens.
- If `POST_ONLY_MAKER` remains reachable through the public adapter method, add a regression test that
  it does not get more optimistic fill semantics than the shared detector intends.
- If POST_ONLY is truly unreachable in paper today, add an explicit test or sentinel around the current
  policy router mapping so the scope stays true.

## Should-Fix Before Dispatch

### M1 - Make `deriveReferencePrice` and synthetic tick construction share one helper

The plan correctly says the reference price and synthesized touch must be mutually consistent. The
least fragile implementation is to extract a small local helper in `StreamingFillAdapter` or
`PaperFillSimulator` that returns both:

```text
{ referencePrice, executableTouchPrice }
```

or a side-aware `ITickSnapshot` built from the same chosen candidate. Duplicating ask/bid/mark/last
fallback logic in two places risks the exact contradiction the plan warns about.

### M2 - Add an anti-regression test for empty ticks at the shared/historical boundary

The plan already asks for "historical empty-tick still misses." Keep that test close to the boundary
that matters:

- Direct shared detector/core test: empty ticks + limit policy -> missed.
- Historical adapter test: replay path still passes recorded ticks, and empty recorded ticks still
  miss.
- Streaming adapter test: live path no longer passes empty ticks for a fresh quote.

This proves M24 did not weaken ADR 0015 C6; it only supplies live event-time evidence that was already
available in the WS snapshot.

### M3 - Keep `no_tick_cached` and stale-tick misses distinct from timeout misses

`PaperFillSimulator` currently records `missedReason: 'no_tick_cached'` when the streaming adapter has
no usable snapshot. Once M24 adds a synthetic tick, tests should continue to cover:

- no cached tick -> `filled=false`, `missedReason='no_tick_cached'`, `lowFidelity=false`;
- stale cached tick -> same missed sentinel via adapter `null`;
- fresh cached tick but non-crossing IOC -> detector miss, `missedReason='timeout'`,
  `lowFidelity=true`.

Those distinctions will matter when operators analyze why paper still did not trade after M24.

### M4 - Scribe note should say "positions may appear only if gate approvals occur"

The plan says M24 alone may not produce visible live volume until M25 because v1/gate constraints may
still block approvals. Good. Tighten the wording slightly: M24 makes a gate-approved open fill; it
does not create approvals. The post-deploy note should distinguish:

- no approvals -> no positions, M24 not exercised live yet;
- approvals with missed fills -> M24 failed;
- approvals with filled opens -> M24 verified in production paper path.

## What Looks Good

- The root-cause diagnosis matches the code: `StreamingFillAdapter` passes `[]`, and the shared
  detector unconditionally misses empty tick arrays for limit policies.
- Keeping the fix in `StreamingFillAdapter` preserves the shared core's conservative no-evidence rule
  and avoids changing M7 backtest semantics.
- The plan correctly treats this as a fidelity correction, not a risk-gate bypass. Strategies still
  emit intents, the risk gate still approves/rejects, and the simulator only resolves fills after
  approval.
- The sequencing is right: M24 before M25. Switching to v2 or relaxing paper stress first would still
  produce zero positions if approved opens continue to miss.
- The QA list has the right shape: crossing fills, non-crossing misses, historical regression,
  determinism, and exits unaffected.
- No migration, no shared contract change, no dashboard scope, and no strategy changes are appropriate
  for this milestone.

## Recommended Dispatch Adjustment

Before implementation, update `docs/plans/archive/M24-paper-open-fill-wiring.md` with these clarifications:

1. Replace the example `high=<ask>, low=<bid>` tick with side-aware executable-price semantics.
2. Add explicit inside-spread non-crossing tests for both long and short.
3. Decide and test the live streaming fill timestamp contract (`snapshot.ts + latencyMs` recommended).
4. State the policy boundary for `POST_ONLY_MAKER`.
5. Require shared fallback logic between reference-price derivation and synthetic tick construction.

After those edits, M24 is a tight and worthwhile milestone. The core idea is correct; the remaining
work is making sure the one synthesized tick represents the actual executable quote, not the whole
spread, and that the resulting live fill is timestamped as an event-time fill rather than a backtest
next-bar fill.
