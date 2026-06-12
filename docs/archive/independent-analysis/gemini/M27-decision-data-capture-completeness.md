# Review of M27 — Decision data-capture completeness

## Summary
The M27 plan focuses on improving the observability and analyzability of the trading bot's decisions. It aims to bridge the gap between the live `decisions` table and the `shadow_decisions` table by adding trade geometry (side, SL/TP, qty, leverage, gate_allowed), recording the specific halt leg directly on the decision row, fixing the hard-coded active positions count, and wiring up a live `book_snapshots` writer keyed by `event_id`. Crucially, this milestone involves schema migrations, making DB safety a top priority.

## Strengths
1. **Comprehensive Observability Upgrade:** The plan systematically addresses all the blind spots identified in the capture audit, ensuring that every decision row contains enough context to reconstruct the intended trade and understand exactly why it was approved or rejected.
2. **Strict DB Safety Protocols:** The plan explicitly enforces the project's DB safety invariants (CLAUDE.md #8/#9). Mandating a `pg_dump` before every migration, requiring additive/nullable columns only, and forbidding destructive operations are excellent safeguards.
3. **Behavioral Isolation:** The plan clearly states that M27 is an observability-only milestone. It explicitly requires QA to assert that gate decisions are byte-identical before and after the changes, preventing accidental logic changes from slipping in with the telemetry upgrades.
4. **Environment-Specific Validation:** Promoting Zod validation to a hard error in non-prod while keeping it warn-only in live is a smart, pragmatic approach. It catches schema drift early in development without risking dropped decisions in production.

## Potential Risks & Recommendations
1. **Migration Performance on Large Tables:**
   - *Risk:* Even with additive, nullable columns, running `ALTER TABLE` on a very large `decisions` table in a live database can sometimes cause brief locks or performance hiccups.
   - *Recommendation:* While likely fine for current data volumes, ensure the migration is executed during a low-activity period if possible, and monitor the engine closely during the 10-minute smoke test for any latency spikes.
2. **`book_snapshots` Retention Policy:**
   - *Risk:* Writing an L2 book snapshot for every event can rapidly bloat the database if retention policies fail or are misconfigured.
   - *Recommendation:* Ensure the retention/rollover policy for `book_snapshots` is aggressively tested. Consider implementing a hard cap on table size or row count, or ensure the partition dropping mechanism is robust and monitored.
3. **Halt Leg Implementation Choice:**
   - *Risk:* The plan offers a choice between storing the halt leg on the decision row OR creating a join helper.
   - *Recommendation:* Strongly prefer storing the halt leg directly on the decision row (as the plan suggests). Date-based joins are notoriously fragile and slow for analytical queries. Denormalizing this specific piece of data onto the decision row will vastly improve query performance and developer experience during analysis.
4. **Zod Validation Edge Cases:**
   - *Risk:* If the Zod schema is updated to require the new fields, old rows (which will have NULLs for the new columns) might fail validation when read back from the database.
   - *Recommendation:* Ensure the updated `marketSnapshotSchema` correctly marks the new fields as `.optional()` or `.nullable()` to maintain backward compatibility with pre-M27 rows.

## Conclusion
The M27 plan is a vital and well-structured milestone that transforms the bot's raw activity into a high-quality dataset for future strategy tuning. The rigorous attention to database safety and the clear separation of observability from trading logic make this a very strong plan. Proceeding with the outlined dispatch waves, with a strong preference for denormalizing the halt leg onto the decision row, is highly recommended.