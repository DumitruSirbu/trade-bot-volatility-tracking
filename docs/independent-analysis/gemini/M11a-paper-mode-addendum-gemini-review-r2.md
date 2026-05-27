# Gemini Review Round 2: M11a-paper-mode-addendum.md (Draft v4)

## 1. Executive Summary
Draft v4 of the `M11a-paper-mode-addendum.md` is a highly mature, defensively engineered document. It successfully folds in all the critical findings from the Round 1 Gemini review, addressing operational blind spots, statistical circularities, and event-loop saturation risks. 

The addition of decisions D14 through D17 shows a rigorous commitment to isolating the paper environment and ensuring that the live-time simulator remains perfectly coherent with the historical backtester without violating causality. The plan is approved for implementation, with only minor forward-looking operational considerations remaining.

## 2. Evaluation of Round 1 Feedback Integration

The v4 draft systematically resolves the concerns raised in the previous review:

*   **D13 Nullity Probe Blind Spots:** **Resolved.** The probe now explicitly checks both `fetchOpenOrders()` and `fetchPositions()`, closing the loop on immediately-filled market/IOC orders. The strong recommendation for a dedicated PAPER sub-account is the correct operational path to assert absolute nullity without brittle prefix filtering. The boot-time capability preflight ensures the probe cannot fail silently.
*   **D5 MTM Event Loop Saturation:** **Resolved.** The introduction of a 100ms throttle (or 1-tick size move early-trip) for mark-to-market and drawdown evaluation perfectly balances the need for intra-bar abort sensitivity with Node.js event loop protection.
*   **D6 & D7 HMAC Threat Model:** **Resolved.** The plan now explicitly bounds the threat model to "tamper-evidence, not tamper-proofing." The operational mitigations (offsite backups of tip hashes, operator logs, and the `CHAIN_RESTORE` row for legitimate backups) make the cryptographic complexity manageable in a real-world deployment.
*   **TOST Pessimistic Bias:** **Resolved.** The shift to an asymmetric TOST band (`ε_upper = +0.05R`, `ε_lower = -0.15R`) is a massive improvement. It correctly punishes optimistic simulator bias while safely allowing a wider margin for conservative, pessimistic bias. The removal of the circular tolerance calculation (now based on risk units `R`) makes the test statistically sound.
*   **D8 `enableFutures` Accessibility:** **Resolved.** The addition of the "Endpoint-accessibility verification" pre-flight step ensures that the strict PAPER allowlist won't crash the bot on boot due to undocumented Binance API requirements.

## 3. Analysis of New Architectural Decisions (v4)

### 3.1. D14: `IAccountStateSource` Port
Splitting `IExecutionClient` was necessary but insufficient. Introducing the `IAccountStateSource` port and strictly binding reconciliation, snapshots, and funding cashflow readers to it is a brilliant architectural move. The module-graph test (R3.1) to enforce this isolation ensures that PAPER mode cannot accidentally leak into live exchange state reads.

### 3.2. D15: `FillSimulatorCore` Extraction
This is the most critical correctness catch in v4. Recognizing that M7's `BacktestRunnerService` is a historical replay engine (which sees the "future" of a bar) while PAPER is a live event-time engine prevents a massive causality violation. Extracting the pure `FillSimulatorCore` and wrapping it in `HistoricalFillAdapter` and `StreamingFillAdapter` ensures both modes use the exact same underlying logic.

### 3.3. D16: Paper-State Source-of-Truth
Explicitly mapping each datum to its single source of truth in PAPER (e.g., `paper_account_state`, `paper_account_state_history`) and guaranteeing atomic writes across the state, history, and audit tables eliminates ambiguity and prevents structural inconsistencies during crashes.

### 3.4. D17: Shadow Randomness (CRN vs. Independent)
Resolving the contradiction between independent rolls and Common Random Numbers (CRN) adds significant statistical rigor. Using independent rolls for active PAPER execution ensures realistic counterfactuals, while using a pre-registered CRN tape for offline comparison maximizes variance reduction and cancels out simulator bias.

## 4. Residual Risks & Forward-Looking Recommendations

While the plan is exceptionally solid, the following operational nuances should be monitored during implementation (Wave R2):

1.  **`StreamingFillAdapter` Complexity (D15):** 
    *   *Risk:* Implementing a streaming adapter that correctly schedules future-tick callbacks for intra-bar SL/TP is notoriously tricky in Node.js. 
    *   *Recommendation:* Ensure rigorous cleanup of scheduled callbacks (e.g., `clearTimeout`) when a position is closed or an order is canceled to prevent memory leaks during long-running soaks.
2.  **TOST Power Floor (lowFidelity section):**
    *   *Risk:* The new TOST power check requires the calibration sample to produce at least 200 simulated fills. If the restricted profile is highly selective, achieving 200 fills even with a diverse zero-edge policy panel over 60 days might be difficult.
    *   *Recommendation:* If the 60-day window consistently fails the 200-fill floor, the runbook should allow extending the calibration window (e.g., to 90 or 120 days) specifically for the TOST calibration, provided market regimes remain comparable.
3.  **Binance API Weight Limits (D13):**
    *   *Risk:* The nullity probe runs `fetchOpenOrders` and `fetchPositions` once per minute. While budgeted, if the symbol universe expands, this could consume a large portion of the IP/UID rate limit weight.
    *   *Recommendation:* Ensure the W1.4 token-bucket policy strictly accounts for this fan-out.

## 5. Conclusion
The `M11a-paper-mode-addendum.md` (v4) is a masterclass in quantitative and software engineering rigor. It leaves no stone unturned regarding execution isolation, statistical validity, and crash safety. The wave structure (R0-R4) with mandatory splits (R2a-R2d) is well-calibrated to manage the rollout complexity. The plan is fully endorsed.