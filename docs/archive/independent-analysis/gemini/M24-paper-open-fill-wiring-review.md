# Review of M24 — Live/paper open-fill wiring

## Summary
The M24 plan addresses a critical bug in the paper trading live-streaming path where all open orders are incorrectly marked as missed fills. The root cause is identified as the `StreamingFillAdapter` passing an empty tick array to the shared `missedFillDetector`. The proposed fix is to synthesize a single intra-bar tick from the live WebSocket snapshot to allow marketable limit IOC orders to fill correctly, without altering the shared core logic or the historical backtest path.

## Strengths
1. **Targeted and Well-Scoped:** The plan correctly isolates the fix to the `StreamingFillAdapter`. By avoiding changes to the shared `missedFillDetector` and `HistoricalFillAdapter`, it minimizes the risk of regressions in backtesting and core fill logic.
2. **Preserves Determinism:** Explicitly mandating that the synthesized tick is built purely from existing snapshot fields and the unchanged HMAC seed ensures that identical inputs will continue to produce identical fills.
3. **Maintains Conservatism:** The plan adheres to the existing `lowFidelity: true` and tier-floor slippage constraints, ensuring the fix doesn't introduce overly optimistic fill prices.
4. **Strict Adherence to Process:** The document rigorously follows the project's dev-qa-cycle, dispatch waves, and DB safety invariants (e.g., requiring a `pg_dump` before engine restart and prohibiting migrations).

## Potential Risks & Recommendations
1. **Tick Synthesis Accuracy:** The plan suggests deriving `high`/`low` for the synthesized tick from the same fields used by `deriveReferencePrice` (e.g., `<ask|last>` and `<bid|last>`). 
   - *Recommendation:* Ensure the snapshot data reliably contains bid/ask or last price information. If a snapshot is malformed or missing these specific fields, the adapter should gracefully fall back (e.g., to the mark price) or safely default to a missed fill rather than throwing an error.
2. **Spread-Crossing Edge Cases:** The plan correctly notes that an IOC priced to cross should fill, while one that does not cross should miss.
   - *Recommendation:* In the QA wave, explicitly include boundary test cases where the synthesized tick's `high`/`low` *exactly* matches the limit price to ensure the `missedFillDetector`'s inclusive/exclusive boundary logic handles the synthesized tick correctly.
3. **Timestamp Alignment:** The plan states `signalBarOpenMs = snapshot.ts` and the tick `ts` sits inside the IOC window. 
   - *Recommendation:* Double-check that the synthesized tick's timestamp strictly satisfies `tick.ts >= signalBarOpenMs` and `tick.ts <= signalBarOpenMs + orderTimeoutMs` to prevent the shared core from discarding the tick due to timeout constraints.

## Conclusion
The M24 plan is exceptionally well-thought-out, safely scoped, and aligns perfectly with the project's conservative, low-risk architecture. The approach of synthesizing a single tick in the adapter rather than modifying the shared core is the correct architectural choice. Proceeding with the outlined dispatch waves is highly recommended.