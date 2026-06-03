# Gemini Review: M19 Per-Coin Liquidity Gate

## Overall Assessment
The plan is structurally sound, accurately diagnoses the root cause of the paper-soak global halts (a per-coin metric incorrectly triggering a global circuit breaker), and proposes a clean, targeted fix. Moving the depth-collapse check to a per-coin eligibility filter (`firstFailingTierFilter`) while retaining the spread-widening check as a global stress signal correctly aligns the implementation with the intended architecture. The fix for the dead breadth threshold is mathematically correct and safely handled via an idempotent migration.

## Strengths
- **Architectural Clarity**: The distinction between global market stress (e.g., a market-wide spread blowout) and per-coin liquidity (a thin order book on a specific altcoin) is correctly restored.
- **Safe Migration Strategy**: Using `jsonb_set` for the breadth threshold update is idempotent and avoids touching the initial seed migration, ensuring both fresh installs and existing environments reach the correct end-state.
- **Strict Adherence to DB Safety Rules**: The explicit requirement for a `pg_dump` before running the migration perfectly respects the project's hard rules (CLAUDE.md invariant #8/#9) to protect irreplaceable soak data.
- **Comprehensive Testing**: The planned tests cover the critical regression path (ensuring a thin coin produces a per-coin reject *without* setting `risk_state.is_halted`).

## Minor Corrections & Technical Callouts

1. **TypeScript Enum Syntax in Constants**
   In `apps/engine/src/risk/const/riskConsts.ts`, the plan specifies:
   `COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = { TIER_1: 20_000, TIER_2: 10_000, TIER_3: 5_000 }`
   Since `CoinTierEnum` values are strings (e.g., `'tier1'`), the object literal should use computed property names to match the existing `TIER_SPREAD_CEILING_PCT` pattern:
   ```typescript
   export const COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
       [CoinTierEnum.TIER_1]: 20_000,
       [CoinTierEnum.TIER_2]: 10_000,
       [CoinTierEnum.TIER_3]: 5_000,
   };
   ```

2. **Postgres `jsonb_set` Type Casting**
   In the migration `UPDATE` statement:
   `UPDATE strategy_versions SET params = jsonb_set(params, '{stress_breadth_pct}', '30')`
   To ensure Postgres stores the value as a JSON numeric type rather than a JSON string, explicitly cast the new value to `::jsonb`:
   ```sql
   UPDATE strategy_versions SET params = jsonb_set(params, '{stress_breadth_pct}', '30'::jsonb)
   ```
   This prevents potential type mismatch issues if the application expects a number when parsing the JSONB `params` column.

3. **Money Constructor Usage**
   The plan proposes:
   `new Money(context.snapshot.book_depth_10bps_usdt).lessThanOrEqualTo(new Money(COIN_DEPTH_FLOOR_10BPS_USDT[intent.coinTier]))`
   This is perfectly safe and consistent with the existing codebase. `context.snapshot.book_depth_10bps_usdt` is a string (validated by `DECIMAL_REGEX`), and passing the hardcoded numeric constants from `COIN_DEPTH_FLOOR_10BPS_USDT` directly to the `Money` constructor (which wraps `decimal.js`) is supported and avoids the float-corruption risks associated with runtime dynamic floats.

## Conclusion
The plan is approved for execution. The dispatch waves are correctly ordered (Architect -> Shared -> Engine -> QA -> Reviewers -> Scribe), and the scope is tightly controlled. Proceed with the implementation, keeping the minor syntax and SQL casting callouts in mind.