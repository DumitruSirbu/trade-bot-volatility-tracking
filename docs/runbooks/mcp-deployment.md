# MCP Deployment Runbook

Operational pre-flight for the read-only MCP server (`apps/mcp`) and its
companion analysis layer (`@bot/analysis`). The MCP server connects to
Postgres as the `mcp_reader` role created by migration
`20260619000000-CreateMcpReaderRole.ts` (see also ADR 0034 —
`docs/architecture/adr/0034-mcp-db-isolation-read-only-role.md`).

## Before launching MCP

The role-creation migration ships with a publicly-known sentinel password
(`mcp_reader_change_me_at_deploy`). MCP will refuse to boot while the
configured `MCP_DB_PASSWORD` still matches the sentinel — `DataSourceFactory`
throws `McpDataSourceConfigError` at `createMcpDataSource()` time.

Required steps:

1. Generate a strong secret (≥32 bytes, e.g. `openssl rand -base64 32`).
2. Rotate the role password against the running database:

   ```sql
   ALTER ROLE "mcp_reader" PASSWORD '<new-secret>';
   ```

3. Set `MCP_DB_PASSWORD=<new-secret>` in the MCP host's environment
   (and in any operator runbooks / secret stores — never in git).
4. Set the remaining required env vars: `MCP_DB_HOST`, `MCP_DB_NAME`.
   `MCP_DB_PORT` defaults to `5433` (matches `trade-bot-postgres` host-side port
   mapping in `docker-compose.yml`; in-container Postgres listens on 5432, but
   host-side port 5432 may collide with a local Postgres instance on the dev
   machine). `MCP_DB_USER` defaults to `mcp_reader`; `MCP_DB_SSL` defaults to
   off (local-dev loopback).
5. Boot MCP. The factory will succeed only if the password is no longer the
   sentinel and every required var is present.

## Verifying the role lockdown

After rotation, confirm the role still carries the ADR 0034 invariants
(`default_transaction_read_only=on`, `statement_timeout=30s`,
`lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`):

```sql
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'mcp_reader';
```

The `rolconfig` array must contain all four settings. If any is missing,
rerun the migration's `up()` against the affected database (the role-level
`ALTER ROLE … SET …` statements are idempotent).

## References

- ADR 0034 §2 — read-only role + grant policy.
- Migration: `apps/engine/src/database/migrations/20260619000000-CreateMcpReaderRole.ts`.
- Factory: `packages/analysis/src/db/DataSourceFactory.ts`.
