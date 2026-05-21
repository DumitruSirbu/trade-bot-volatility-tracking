# Testing

## Engine (Jest)

- Unit tests mock repositories/services and the exchange client. No real DB, no real exchange.
- Integration tests against a real Postgres (testcontainers or a dedicated `bot_test` DB).
- File location: mirror source under `__tests__/`. `service/RiskService.ts` → `service/__tests__/RiskService.spec.ts`.
- Factory functions for seed data — no shared mutable state.
- F.I.R.S.T.: Fast, Independent, Repeatable, Self-Validating, Timely.

### Trading-domain tests that MUST exist

- **Risk gate:** rejects over-limit / over-exposure / cooldown / illiquid signals; passes within-limit; boundary at exactly the limit.
- **Strategy determinism:** same market-state input → same signal across repeated runs.
- **Idempotent execution:** replaying an order intent or restarting does not double-place.
- **Position lifecycle:** open → add → reduce → close; realized PnL and `exit_reason` correct on close.
- **Reconciliation:** local/exchange divergence detected and corrected.
- **Money math:** decimals exact at boundaries (zero, negative, large); short vs long signs correct.
- **Backtest = live:** strategy over canned candles yields the live path's decisions.

## Dashboard (Vitest + Testing Library)

- Co-locate `.test.tsx` with the component.
- Mock the network via MSW (or stub the apiClient); mock the WS/SSE stream for live components.
- Query by role/label, not test-id.
- Kill-switch button: confirm step, auth, halted-state reflection.

## Coverage targets

Pragmatic, not numeric — every business rule and risk invariant has at least one test that breaks if the rule changes. No naked happy paths.
