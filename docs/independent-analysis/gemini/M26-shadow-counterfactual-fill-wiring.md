# Review of M26 — Shadow counterfactual fill wiring

## Summary
The M26 plan addresses a critical gap in the shadow trading pipeline where simulated fills always fail because they are passed an empty tick array and collapsed bar extremes. To fix this, the plan proposes loading real `tick_aggregates` and true bar extremes (high/low) from the database during shadow orchestration, mirroring the M7 backtesting approach. This will allow dormant strategies (v2, v3) to generate accurate virtual PnL for counterfactual comparison without altering the shared core logic.

## Strengths
1. **Consistency with Backtesting:** By reusing the existing M7 `tick_aggregates` repository/loader, the plan ensures that the shadow path and the backtest path evaluate fills using the exact same data source and semantics.
2. **Architectural Isolation:** The strong preference for "Design A" (DB load in the orchestrator) correctly avoids bloating the `IVolatilityDetectedEvent` payload in the shared contract. It keeps the live event stream lightweight and isolates the heavy data loading to the offline shadow path.
3. **Explicit Missing-Data Handling:** The decision to conservatively tag missing data rather than silently fabricating ticks is excellent. It prevents survivorship bias in the counterfactual analysis.
4. **Preservation of Low Fidelity:** The plan strictly adheres to ADR 0029 by maintaining `lowFidelity: true` and `bookSnapshot: null`, ensuring the scope doesn't creep into depth-aware simulation prematurely.

## Potential Risks & Recommendations
1. **Database Race Conditions (Live vs. Shadow):**
   - *Risk:* In a live environment, the shadow orchestrator processes events shortly after they occur. There may be a race condition where the `tick_aggregates` for the signal bar have not yet been fully flushed/committed to the database by the market data writer when the orchestrator queries them. This would trigger the "missing-tick" path unnecessarily.
   - *Recommendation:* Evaluate the timing between the event emission and the shadow orchestrator's DB query. If a race condition exists, consider introducing a slight, deliberate delay in the shadow orchestrator (since it runs off the critical live trade loop) to ensure `tick_aggregates` are fully written before querying.
2. **Database Load and Caching:**
   - *Risk:* While the shadow path runs off the critical loop, querying the database for every shadow event across multiple dormant strategies could introduce unnecessary DB load.
   - *Recommendation:* Ensure the `tick_aggregates` table is optimally indexed on `(symbol, entryCandleOpenTime)`. If multiple shadow strategies (e.g., v2 and v3) process the exact same event concurrently, consider a short-lived, request-scoped in-memory cache in the orchestrator to avoid duplicate DB queries for the same bar.
3. **Design Choice Confirmation:**
   - *Recommendation:* Strongly endorse **Design A**. Design B would couple the live event producer to shadow simulation requirements, violating separation of concerns.

## Conclusion
The M26 plan provides a robust, well-isolated solution to enable shadow PnL generation. It correctly leverages existing backtest infrastructure and avoids polluting the shared live event contract. Addressing the potential DB write-read race condition during implementation will ensure the shadow path receives the data it needs rather than defaulting to the missing-data path. Proceeding with Design A and the outlined dispatch waves is highly recommended.