# Schema Fail Recovery

When the engine boot fails at PHASE 0 (startup schema validation), an operator must recover the database state before restarting.

## What happened

The engine refused to start because one or more required TypeORM migrations were not applied or the Postgres schema was out of sync. The stderr block (printed to console by the process) shows which table or column was missing.

## Recovery steps

1. **Read the stderr block.** The engine prints a detailed error message showing the missing table/column name and which migration should have created it. Example:
   ```
   [FATAL] Schema validation failed: relation "candles" does not exist
   ```

2. **Check pending migrations:**
   ```bash
   pnpm migration:show
   ```
   This lists all migrations: applied (green), pending (red), and reverted (grayed).

3. **Apply all pending migrations:**
   ```bash
   pnpm migration:run
   ```

4. **Verify the schema is now complete:**
   ```bash
   pnpm migration:show
   ```
   All migrations should show as applied (green). If any remain pending, check logs for SQL errors and fix them (often constraint violations or duplicate data on revert).

5. **Restart the engine:**
   ```bash
   pnpm start
   ```

## If drift is real

If the schema is partially broken (e.g., a table exists but columns are missing, or a migration partially rolled back), the drift is a **database bug**, not a schema issue. Open an engineer ticket with:
- The migration name that failed
- The exact Postgres error (from logs)
- The manifest vs `information_schema.columns` discrepancy (if known)

Do NOT manually edit the schema; let the engineer investigate whether a migration needs repair or if a new repair migration should be created.

## Fallback: nuke and restart (dev/test only)

If the Postgres instance is corrupted beyond repair and this is a dev or test environment:
```bash
docker-compose down -v  # Remove all volumes
docker-compose up -d postgres
pnpm migration:run      # Re-apply all migrations from baseline
```

**Never do this in production.** Live data loss is permanent.
