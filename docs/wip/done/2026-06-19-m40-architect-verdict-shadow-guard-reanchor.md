## 2026-06-19 — M40 D2 — ARCHITECT VERDICT: wrong-side-of-stop typed-miss vs. re-anchor (live-vs-shadow parity)

**Scope:** investigation + adjudication only, no code. Settles the conflict between the shipped D2 typed-miss
(`WRONG_SIDE_OF_STOP`) and the D2.0 / reviewers' re-anchor recommendation, traced from code (not docs).

### 1. The decisive question, answered from code: live HOLDS these fills, it does NOT reject them.

The live wrong-side-of-SL guard is genuinely active at runtime, but it operates on a **different quantity** than
the shadow guard, so it does NOT see the divergence the shadow rejects on.

- **Live guard is active and magnitude-independent.** `evaluateFillDrift` (`exitGeometryHelper.ts:45-49`)
  computes `isWrongSideOfStop` and returns `{ shouldReject: true, reason: 'wrong_side_of_sl' }` unconditionally —
  *before* the `MAX_SIGNAL_DRIFT_PCT` magnitude leg (`:53-65`). The magnitude leg ships disabled
  (`executionConsts.ts:231` `MAX_SIGNAL_DRIFT_PCT = undefined`), but the wrong-side leg runs regardless. Its
  caller `rejectAndUnwindIfUnacceptable` (`ExecutionService.ts:1035-1057`) is invoked on every OPEN/ADD confirmed
  fill (`:946`, `isOpenIntent`). The check is NOT dormant. **(implementer's premise "live rejects too" is testable
  and turns out false — see next.)**

- **Live keys the check on `avgFillPrice` = the ACTUAL exchange/paper taker fill, NOT a tick-reconstruction.**
  `evaluateFillDrift({ avgFillPrice: fillSummary.avgFillPrice, … })` (`ExecutionService.ts:1037-1043`).
  `fillSummary` comes from `fillAccumulator.toSummary(snapshot)` where `snapshot` is the order-execution result of
  `runSubmitStateMachine` (`:205`, `:252`, `:924`). In paper, that fill price is the **live taker price at
  order-submission time** — ask for LONG opens, bid for SHORT opens, from the live tick cache
  (`PaperFillSimulator.deriveReferencePrice`, `:285-288`; `translateToFillIntent`, `:262-277`). In live it is the
  real Binance fill. Either way it is a *near-event live taker price*, within taker-slippage of
  `reconstructReferencePrice` (the event-time reference the strategy drew its SL against).

- **The strategy's SL is anchored on `reconstructReferencePrice` (event-derived), and the SL is never moved by
  the live fill.** `meanReversionCore.buildMeanReversionExit` → `computeStructuralStop(tradeSide,
  reconstructReferencePrice(event), resolveDeviationWickPrice(event), …)` (`meanReversionCore.ts:134-140`).
  `reconstructReferencePrice = vwapSession × (1 + vwapDeviationPct/100)` (`entryHelpers.ts:42-46`). Its own comment
  (`entryHelpers.ts:41`) is the smoking gun: *"Used as the proposed entry price in dry-run … live fills replace it
  downstream."* Live replaces the **entry** with the actual fill; the **SL stays where the strategy drew it**, a
  hair beyond the wick relative to the event reference. So in live, fill and SL are both within taker-slippage of
  the same event reference → `isWrongSideOfStop` is false → **live HOLDS the position.** A live wrong-side reject
  fires only on a genuine fat-tail gap between submission and the event reference, which is exactly the rare
  malformed-geometry case D2 was designed for.

- **The shadow keys the same check on a DIFFERENT quantity: `nextBarOpenPrice` = the signal-bar LAST-TICK CLOSE**
  (`ShadowStrategyOrchestratorService.ts:275`, used as `entryPriceStr` at `:382`, validated at `:392`). This is a
  *different temporal point* than both the event reference and the live taker fill. The DB evidence is decisive:
  187/187 v1 gate-allowed opens since 06-10 rejected, sampled WARN `side:long entry:0.6805 stopLoss:0.68835` =
  stop ~1.15% ABOVE a LONG entry. A 1.15% gap is an order of magnitude larger than taker slippage — it is the
  signal-bar-close-vs-event-reference divergence, NOT a fill-acceptance event. Live, fed the taker price instead,
  never sees a gap this size and therefore never rejects these.

**Conclusion (1):** Live **HOLDS** these positions; the shadow **REJECTS** them. The typed-miss is therefore
**censoring trades the live arm actually takes** — the shadow and live diverge under the shipped D2. The
reviewers/D2.0 are correct; the implementer's parity premise ("re-anchoring would make shadow diverge from live")
is inverted — the shadow is *already* diverged, and the typed-miss freezes that divergence in place.

### 2. Verdict on the D2 approach: (B) re-anchor — fix shape #1. Reject (A) typed-miss.

Keep the shadow entry **tick-derived** (`nextBarOpenPrice`) — do NOT substitute `reconstructReferencePrice` as the
fill (that would restate the live decision as its own counterfactual and risk look-ahead; HIGH-1/B4 stands).
**Validate the stop-side against the reference the stop was geometrically drawn from** (`reconstructReferencePrice`),
which the strategy already guarantees by construction (`meanReversionCore` draws the SL on the correct side of its
own reference and additionally guards `isDegenerateReversionGeometry`, `:159-168`). Then **fill at the tick-derived
`nextBarOpenPrice`, keep the strategy's SL price level unchanged, and let the intrabar walk decide
sl/tp/time_stop/force_close.** This is fix shape #1 and it restores parity: live holds → shadow holds and lets the
walk adjudicate the outcome honestly, instead of recording a fabricated rejection live never makes.

The malformed-strategy protection the original guard claimed (`isStopSideValid`) is **double-counted**: a
genuinely malformed stop (drawn on the wrong side of its *own* reference) is already caught at the strategy layer.
Re-pointing the shadow's stop-side validation to `(reconstructReferencePrice, stopLossPrice)` preserves that
protection against a truly malformed strategy while removing the spurious tick-entry mismatch.

### 3. Behaviour when the tick-derived entry is already past the (unmoved) SL.

Under fix shape #1 the SL is the strategy's price level, NOT rebased. The walk then handles the geometry honestly:

- If `nextBarOpenPrice` is already on the wrong side of the (unchanged) strategy SL at fill, the **intrabar walk
  records an immediate stop-out on the first tick of the walk window** — `close_reason = stop_loss`, fill at the
  SL price level (or the entry if the walk models entry-then-immediate-breach; the existing `walkNextBarExit` SL
  detection owns this). **Realized PnL = the entry-to-SL distance** (a small structural loss, ≈ −1R bounded by the
  structural stop), which is exactly what a live position opened at that price and protected by that SL would
  realize. This is faithful to live: live would hold, the SL would protect, and the position would stop out for
  the same bounded loss. It is NOT a fabricated 0-qty miss.
- This deliberately replaces the current outcome (a `missed:true`, `qty:'0'` row that produces **no PnL and no
  close_reason**), which is the censorship. The re-anchor turns a censored non-event into a modeled bounded-loss
  trade — restoring the close_reason distribution the B5 re-qualification gate requires (not ~100% force_close /
  not ~100% miss).

**ADR 0045 §D1.1 compliance:** fix shape #1 does **NOT** rebase the SL — it fills at the tick entry and leaves
`stopLossPrice` exactly as the strategy emitted it. ADR 0045 §D1.1 ("SL is never rebased", `:52-53`; D2
wrong-side check, `:108-113`) forbids *moving the SL anchor*; it says nothing against filling at a tick entry and
letting an immediate stop-out resolve. The mean-reversion SL is structural (`atrDistance:null`,
`tpRebaseEligible:false`, `meanReversionCore.ts:150-151`), so there is no distance to rebase and none is rebased.
**No §D1.1 violation.** (This is precisely why fix shape #1 is preferred over D2.0's "alternative" #2, which WOULD
carry-and-reapply a stop *distance* onto the tick entry — that flirts with a structural-SL rebase and is the
heavier, §D1.1-adjacent change. Reject #2; take #1.)

### 4. The ADR 0029 "Clarifying note (M40 D2)" must be REVISED.

As written (`0029-…md:715-723`) the note is **incorrect on its central claim**: *"This mirrors the live arm's
`evaluateFillDrift` `wrong_side_of_sl` FLATTEN-unwind contract."* It does not mirror live — it diverges from live.
Live evaluates wrong-side against `avgFillPrice` (the actual taker fill, within slippage of the SL anchor) and
**holds** these positions; the shadow evaluates against `nextBarOpenPrice` (signal-bar close, ~1% off the SL
anchor) and **rejects** them. The two guards key on different quantities, so the shadow rejection is not the
counterfactual of the live FLATTEN-unwind — it is an artifact of validating a correctly-built SL against the wrong
entry reference. The note's §D1.1 reasoning ("rebasing the SL would corrupt realized risk") is true *in the
abstract* but is a non-sequitur here, because fix shape #1 does not rebase the SL at all.

**Required revision:** replace the note with a record that (a) the shipped `WRONG_SIDE_OF_STOP` typed-miss was a
parity defect (it censored trades live holds), (b) the shadow stop-side check is validated against
`reconstructReferencePrice` — the anchor the strategy drew the SL from — and the fill stays tick-derived
(`nextBarOpenPrice`), and (c) when the tick entry is already past the unchanged SL, the intrabar walk records an
immediate structural stop-out (bounded ≈ −1R loss), not a 0-qty miss. The §D1.1 "SL never rebased" invariant is
**reaffirmed and not touched** by this fix.

**Routing:** this verdict reverses the shipped D2 implementation behaviour (typed-miss → fill+walk) and the ADR
0029 amendment. Hand to the orchestrator for an implementation wave on
`ShadowStrategyOrchestratorService` (shadow-path only; no live trade path touched, determinism holds — entry stays
tick-derived, no `Date.now()`), with the ADR 0029 note revision routed through the architect/scribe.
