# Data model

The authoritative schema lives in the engine's TypeORM entities under
`apps/engine/src/<module>/entity/` plus the reversible migrations in
`apps/engine/src/database/migrations/`. ADR 0002 documents the persistence
philosophy (domain-owned entities, `decimal` for money, snake_case columns,
explicit `synchronize: false`). This file collects cross-cutting policies
that apply across modules.

## MCP read-grant policy

The MCP server (`apps/mcp/`, ADR 0033) connects to Postgres under the
`mcp_reader` role created by
`20260619000000-CreateMcpReaderRole.ts`. The role is `LOGIN`-only,
`default_transaction_read_only = on`, with `statement_timeout = 30s`,
`lock_timeout = 5s`, and `idle_in_transaction_session_timeout = 60s` (see
ADR 0034 §2.1 for rationale).

**Default is no grant.** A new table added by any future migration is
**invisible** to MCP until a follow-up migration explicitly issues
`GRANT SELECT ON TABLE <name> TO mcp_reader`. There is no `GRANT SELECT ON
ALL TABLES` and no `ALTER DEFAULT PRIVILEGES`-based blanket — both would
defeat the safe-by-default policy.

**Currently granted (whitelist):**

- Market data: `candles`, `tick_aggregates`, `instruments`,
  `universe_membership`, `funding_rates`, `open_interest`,
  `book_snapshots`.
- Trading state: `strategy_versions`, `positions`, `transactions`,
  `decisions`, `risk_state`, `account_snapshots`.

**Never granted (sensitive — see ADR 0034 §2.5):**

- Auth / control: `revoked_jti`, `control_audit`, `login_rate_limit_state`.
- Boot-mode HMAC chain: `boot_mode_history`, `boot_mode_chain_rotations`.
- Paper-mode persistence (contains derived simulator state +
  HMAC-chained audit): `paper_account_state*`, `paper_account_snapshots`,
  `paper_simulator_idempotency`, `paper_state_audit`.
- Internal artefacts: `migrations`, `comparison_reports`.

**Author checklist when adding a table:**

1. Decide explicitly whether MCP should see the new table.
2. If yes — add `GRANT SELECT ON TABLE "<name>" TO "mcp_reader"` and a
   matching `REVOKE` for non-SELECT in the same migration's `up()`, and
   the symmetric `REVOKE ALL` in `down()`. Update this whitelist block.
3. If no — do nothing. The default already protects the table; record the
   "intentional exclusion" reason in the migration's header comment if
   the call is non-obvious.

The boundary between MCP and the engine writer is structural (ADR 0033
workspace dependency graph + ESLint `no-restricted-imports`). The
read-grant policy here is the second layer: even if the boundary is
breached, Postgres rejects the write.
