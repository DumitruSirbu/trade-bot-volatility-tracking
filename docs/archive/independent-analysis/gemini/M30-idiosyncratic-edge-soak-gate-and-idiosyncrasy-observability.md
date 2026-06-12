# Review: M30 — Idiosyncratic-edge soak gate + idiosyncrasy observability

## 1. Summary
The M30 plan focuses on observability and measurement rather than introducing new trading behaviors. It explicitly defers the development of the correlated slot-C strategy until sufficient data (≥20 closed idiosyncratic trades across ≥3 trading days) is collected from the M29 soak. The milestone introduces two new analysis queries (`getIdiosyncraticEdgeReport` and `getIdiosyncrasyMissDistribution`) and adds a conservative noise floor (`IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05`) to the `computeIdiosyncrasyScore` pure function to prevent near-zero-noise inflation.

## 2. Strengths
- **Data-Driven Approach:** The plan strictly adheres to the principle of not building features (like the slot-C leg) without empirical evidence. Waiting for the M29 soak to yield actionable data is a highly disciplined and conservative approach, aligning perfectly with the project's "survival over returns" priority.
- **Clear Boundaries:** The scope is extremely well-defined. It explicitly lists what will *not* change (no schema migrations, no DB param changes, no threshold moves), which minimizes the risk of unintended side effects.
- **Safe Runtime Change:** The only runtime change (the noise floor in `computeIdiosyncrasyScore`) is provably tightening. It only removes false idiosyncratic eligibility and is asserted to be inert for real trigger magnitudes.
- **Comprehensive Testing:** The testing requirements are thorough, especially the inertness regression tests for the noise floor and the boundary tests for the new analysis queries.

## 3. Weaknesses & Risks
- **Soak Duration Uncertainty:** As noted in the Open Questions, accumulating 20 closed idiosyncratic trades might take significantly longer than 14 days, especially with other rejection reasons (`sl_outside_liquidation`, `market_stress`, etc.) dominating the funnel. This could stall further development.
- **Advisory Regime Robustness:** The `regimeRobustnessPasses` flag is advisory and not part of the hard gate. While the rationale (structural bias toward `btc_5m_flat`) makes sense, there's a risk that a positive overall expectancy driven entirely by one specific micro-regime might be misinterpreted as a broadly robust edge.
- **Miss-Distance Bucketing:** The miss-distance histogram uses fixed buckets (`[0,0.1)...[0.4,0.5]`). If the actual distribution of marginal misses is highly concentrated (e.g., mostly between 0.45 and 0.5), these buckets might not provide enough granularity to inform the future threshold calibration effectively.

## 4. Recommendations
- **Monitor Funnel Velocity Closely:** If the idiosyncratic fill rate is too low, prioritize the `sl_outside_liquidation` forensics (currently a tech-debt MEDIUM) to unblock the funnel before waiting indefinitely for the 20-trade threshold.
- **Granular Miss-Distance Buckets:** Consider making the top bucket (`[0.4,0.5]`) more granular (e.g., `[0.4, 0.45)`, `[0.45, 0.5]`) if the goal is to identify marginal misses that could justify a slight threshold relaxation in the future.
- **Document the "Wait" Protocol:** Explicitly document the protocol for what the team should focus on if the soak takes 4-6 weeks instead of 14 days. Having a backlog of non-trading, non-interfering tech-debt items ready will prevent idle hands from prematurely pushing for the slot-C build.
