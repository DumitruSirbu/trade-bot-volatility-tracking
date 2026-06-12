# ADR 0036 — `agent_writer` role + `draft_strategy_version` SDF (status='draft' by construction)

**Status:** Accepted (M13 W0 — orchestrator-blessed config-row + HTTP transport + compose cron)
**Date:** 2026-05-27
**Milestone:** M13 — Agentic weekly loop
**Depends on:** ADR 0034 (MCP DB isolation: read-only role pattern), ADR 0033 (MCP module boundary), ADR 0016 (strategy version lineage + promotion), ADR 0019 (promotion gate is human-only), ADR 0035 (agent structural boundary).
**Consumed by:** M13 W0.2 (`CreateAgentWriterRoleAndSdf` migration), M13 W0.3 (`CreateAgentRunHistory` migration), M13 W3 (draft persistence), M13 W6 (DB-role adversarial QA).
**Related:** `docs/plans/archive/M13-execution-plan.md` §"Inputs locked", §W0 items 2 + 3, §W6a vectors 3 + 4, §Test strategy item 6.

## 1. Context

M13's agent must INSERT rows into `strategy_versions` (a draft proposal per
weekly run) and INSERT rows into `agent_run_history` (one summary row per
run, including idempotency-skip rows). It must NOT be able to:

- Activate any strategy version (`UPDATE strategy_versions SET status='active'`).
- Write any row with `status` other than `'draft'`.
- Touch any other table — `positions`, `decisions`, `account_snapshots`,
  `auth_tokens`, `paper_account_state`, `risk_state`, `control_audit`, etc.
- Modify the SDF body, replace the function, or escalate via search-path
  shenanigans.
- Drop / alter / truncate any object.

ADR 0034 established a least-privilege Postgres role pattern (`mcp_reader`)
with `default_transaction_read_only=on`, `statement_timeout`, `lock_timeout`,
and a tight `SELECT` grant set on 13 whitelisted tables. M13 extends that
pattern to a writer role — but the writer role's only write path is a
`SECURITY DEFINER` function whose body hard-codes the only acceptable
write.

The orchestrator has locked the input:

> Single SDF `draft_strategy_version(p_parent_version_id integer, p_params
> jsonb, p_rationale text, p_week_iso text)` is the ONLY write capability
> granted to `agent_writer`. `status='draft'` hard-coded in the SDF body.

This ADR locks the role, grants, SDF body shape, idempotency contract, and
paired-test discipline before the W0 migration ships.

## 2. Decision

### 2.1 Role `agent_writer`

Created by migration `<timestamp>-CreateAgentWriterRoleAndSdf.ts`:

```
CREATE ROLE "agent_writer" LOGIN PASSWORD '<sentinel>';
ALTER ROLE "agent_writer" SET default_transaction_read_only = on;
ALTER ROLE "agent_writer" SET statement_timeout = '30s';
ALTER ROLE "agent_writer" SET lock_timeout = '5s';
ALTER ROLE "agent_writer" SET idle_in_transaction_session_timeout = '60s';
GRANT CONNECT ON DATABASE "<engine_db>" TO "agent_writer";
GRANT USAGE ON SCHEMA public TO "agent_writer";
```

Notes:

- `default_transaction_read_only = on` is intentional even though the role
  needs to call a write SDF. The SDF is `SECURITY DEFINER` and runs as the
  function owner (a different role); its body explicitly sets
  `SET LOCAL transaction_read_only = off` at entry. Outside the SDF the
  role can issue only SELECT statements — even if a future grant slips in,
  the session-level RO flag blocks accidental DML.
- The sentinel password is rotated by the operator pre-launch (mirrors
  ADR 0034 §2.1 / M11a paper-mode pattern). `AgentPgClient` (M13 W3) refuses
  to boot while `AGENT_DB_PASSWORD` matches the sentinel string.
- `lock_timeout = 5s` matches `mcp_reader` — the agent never blocks the
  engine writer for more than 5 seconds on any row lock.

### 2.2 GRANT set (SELECT — identical 13 tables as `mcp_reader`)

The 13-table whitelist is re-cited from ADR 0034 §2.5 — the agent's read
needs are a subset of MCP's:

`candles`, `tick_aggregates`, `instruments`, `universe_membership`,
`funding_rates`, `open_interest`, `book_snapshots`, `strategy_versions`,
`positions`, `transactions`, `decisions`, `risk_state`, `account_snapshots`.

GRANT statements:

```
GRANT SELECT ON candles, tick_aggregates, instruments, universe_membership,
                funding_rates, open_interest, book_snapshots,
                strategy_versions, positions, transactions, decisions,
                risk_state, account_snapshots TO "agent_writer";
```

**Explicitly NOT granted (sensitive — same blocklist as ADR 0034 §2.5):**
`auth_tokens`, `revoked_jti`, `control_audit`, `paper_account_state*`,
`boot_mode_history*`, `key_permission_*`, `crn_tape`, `agent_run_history`
(SELECT yes for read-back; see §2.6), any HMAC/audit chain table.

**No table-level INSERT/UPDATE/DELETE grant on any table — including
`strategy_versions` and `agent_run_history`.** The only write path is the
SDF (see §2.3).

### 2.3 SDF `draft_strategy_version`

```
CREATE OR REPLACE FUNCTION draft_strategy_version(
    p_parent_version_id integer,
    p_params            jsonb,
    p_rationale         text,
    p_week_iso          text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_parent_name    text;
    v_parent_status  text;
    v_new_version    integer;
    v_inserted_id    integer;
BEGIN
    SET LOCAL transaction_read_only = off;

    -- Validate parent exists AND is active.
    SELECT name, status INTO v_parent_name, v_parent_status
    FROM strategy_versions
    WHERE strategy_version_id = p_parent_version_id;

    IF v_parent_name IS NULL THEN
        RAISE EXCEPTION 'parent_version_id % not found', p_parent_version_id
            USING ERRCODE = '23503';
    END IF;

    IF v_parent_status <> 'active' THEN
        RAISE EXCEPTION 'parent_version_id % is not active (status=%)',
            p_parent_version_id, v_parent_status
            USING ERRCODE = '22023';
    END IF;

    -- Compute next version number for the family.
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_new_version
    FROM strategy_versions
    WHERE name = v_parent_name;

    -- Idempotent insert: ON CONFLICT (parent_version_id, week_iso) returns NULL on re-fire.
    INSERT INTO strategy_versions
        (name, version, parent_version_id, params, rationale, week_iso, status, created_at)
    VALUES
        (v_parent_name, v_new_version, p_parent_version_id, p_params,
         p_rationale, p_week_iso, 'draft', now())
    ON CONFLICT (parent_version_id, week_iso) DO NOTHING
    RETURNING strategy_version_id INTO v_inserted_id;

    RETURN v_inserted_id;  -- NULL when idempotent-skipped.
END;
$$;
```

Locked properties:

- **`SECURITY DEFINER`** — runs as the function owner, which is NOT
  `agent_writer`. The owner is a dedicated migration role (e.g.,
  `bot_migration` or the database superuser-equivalent role that owns
  every other engine object). `agent_writer` cannot `ALTER FUNCTION
  draft_strategy_version OWNER TO ...` because it does not own the
  function and is not a superuser.
- **`SET search_path = pg_catalog, public`** at function level — prevents
  search-path hijack attacks where a malicious row in a user-writable
  schema shadows a system function.
- **`status='draft'` is a literal in the INSERT body** — no parameter, no
  variable, no concatenation. There is no syntactic path for the caller
  to influence the status value.
- **Validates parent exists AND is `status='active'`** — drafts can only
  parent off the currently-active version. Drafting off a draft would
  enable a chain of agent self-references that ADR 0019's promotion gate
  is not designed to evaluate.
- **`version = max(version) + 1 WHERE name = parent.name`** — preserves
  ADR 0016's lineage discipline; the family name is inherited from the
  parent, never supplied by the caller.
- **Idempotent on `(parent_version_id, week_iso)`** — a re-fired cron in
  the same ISO week returns `NULL` rather than raising. Caller maps
  `NULL` to `terminal_state='IDEMPOTENT_SKIP'`.

### 2.4 New UNIQUE constraint

The idempotency contract requires a new partial UNIQUE constraint, added
in the same migration:

```
ALTER TABLE strategy_versions
    ADD CONSTRAINT uq_strategy_versions_parent_week
        UNIQUE (parent_version_id, week_iso)
        WHERE week_iso IS NOT NULL;
```

Partial-index form: existing non-agent-authored versions have `week_iso IS NULL`
and remain unconstrained. Only agent-drafted rows are subject to the unique
key.

A nullable `week_iso text` column is added to `strategy_versions` if not
already present. Format: `YYYY-Www` (ISO 8601 week date — e.g.,
`2026-W22`). Documented in `docs/architecture/data-model.md`.

### 2.5 GRANTs on the SDF

```
GRANT EXECUTE ON FUNCTION draft_strategy_version(integer, jsonb, text, text)
    TO "agent_writer";
REVOKE EXECUTE ON FUNCTION draft_strategy_version(integer, jsonb, text, text)
    FROM PUBLIC;
```

`agent_writer` can EXECUTE. Nothing else. PUBLIC's default EXECUTE on
new functions is explicitly revoked.

### 2.6 `agent_run_history` table

Created by migration `<timestamp>-CreateAgentRunHistory.ts`:

| Column                  | Type            | Notes                                                                            |
|-------------------------|-----------------|----------------------------------------------------------------------------------|
| `agent_run_id`          | serial PK       |                                                                                  |
| `week_iso`              | text UNIQUE NOT NULL | ISO week (`YYYY-Www`); one row per cron firing per week.                       |
| `parent_version_id`     | integer NOT NULL FK | references `strategy_versions`.                                              |
| `draft_version_id`      | integer NULL FK | references `strategy_versions`; NULL when `terminal_state='SKIPPED_HALTED'` or `'FAILED'` before SDF call. |
| `model_id`              | text NOT NULL   | LLM model id used (`anthropic/claude-opus-4-7` or fallback).                    |
| `report_md_path`        | text NULL       | filesystem path under `AGENT_REPORT_DIR`.                                        |
| `report_json_path`      | text NULL       | machine-readable companion.                                                      |
| `terminal_state`        | enum NOT NULL   | `COMPLETED | SKIPPED_HALTED | IDEMPOTENT_SKIP | FAILED`.                         |
| `failure_reason`        | text NULL       | populated when `terminal_state='FAILED'` (e.g., `WALLCLOCK_EXCEEDED`).           |
| `bootstrap_ci_lo`       | numeric NULL    | from `IBacktestReport.bootstrap.ci.lo` of the draft.                             |
| `bootstrap_ci_hi`       | numeric NULL    | from `IBacktestReport.bootstrap.ci.hi` of the draft.                             |
| `passes_promotion_gate` | boolean NULL    | ADR 0019 12-criterion check, operator-facing only.                               |
| `started_at`            | timestamptz NOT NULL |                                                                              |
| `finished_at`           | timestamptz NULL |                                                                                 |

Grants:

- `GRANT SELECT ON agent_run_history TO mcp_reader` — dashboard reads via M12.
- `GRANT SELECT ON agent_run_history TO agent_writer` — agent reads back its own history rows.
- **No table-level INSERT/UPDATE/DELETE grant to `agent_writer`.** Writes go
  through the SDF only — a future migration may extend the SDF (or add a
  sibling SDF) to INSERT into `agent_run_history`. **M13 W3 may grant
  table-level INSERT on `agent_run_history` to `agent_writer` as a
  pragmatic narrow exception** if a sibling SDF proves excessive; the
  decision is delegated to W3 and documented in this ADR's amendment log
  if taken. The boundary-critical constraint — that `strategy_versions`
  writes go through the SDF only — is unaffected either way.

### 2.7 Defense-in-depth: SDF body paired test

Mirrors M13 §Test strategy item 6. A test under
`apps/engine/tests/migrations/` reads:

```
SELECT prosrc FROM pg_proc
WHERE proname = 'draft_strategy_version';
```

And asserts:

1. The substring `'draft'` is present (the literal status value).
2. The substring `'active'` is absent (no path to write `status='active'`).
3. The substring `SECURITY DEFINER` keyword pair is set on the function
   metadata (via `prosecdef = true` on `pg_proc`).
4. The function owner is **not** `agent_writer`.

The test runs in CI on every migration test pass. If a future migration
edits the SDF body and accidentally introduces `'active'` (e.g., by
parameter-izing status), the test fails before the migration ships.

### 2.8 Defense-in-depth: privilege adversarial tests (W6a vector 4)

Under the `agent_writer` role:

- `INSERT INTO strategy_versions (..., status) VALUES (..., 'active')`
  → expect `42501 insufficient_privilege` (no table-level INSERT grant).
- `UPDATE strategy_versions SET status='active' WHERE strategy_version_id = X`
  → expect `42501` (no UPDATE grant).
- `DELETE FROM strategy_versions WHERE strategy_version_id = X`
  → expect `42501`.
- `ALTER FUNCTION draft_strategy_version OWNER TO agent_writer`
  → expect `42501` (not the owner).
- `CREATE OR REPLACE FUNCTION draft_strategy_version(...) ...`
  → expect `42501` (not the owner).
- `SELECT * FROM auth_tokens` → expect `42501` (no SELECT grant).
- A second call to `draft_strategy_version` with the same
  `(parent_version_id, week_iso)` → expect `RETURNS NULL` (idempotency).

All seven assertions are required-green before M13 closes.

## 3. Consequences

**Positive.**

- `strategy_versions.status='active'` cannot be written by the agent under
  any code path: no table-level grant exists, and the SDF body has no
  syntactic route to that literal.
- Idempotent cron re-fires are silent (`RETURNS NULL`) rather than raising
  — operator-friendly and CI-friendly.
- The 30-second statement timeout caps any agent DB call.
- The role's read surface is identical to MCP's, so the audit story is
  "the agent reads what MCP reads, plus calls one function" — operators
  inherit M12's mental model.
- `pg_stat_statements` integration test (M13 W6 §Test strategy item 5)
  observes exactly two write-statement shapes across a full agent run:
  the SDF body's INSERT and the `agent_run_history` INSERT.

**Negative.**

- The SDF body owns the family-name derivation and the version-number
  computation. A future schema change (e.g., adding `tags` to
  `strategy_versions`) requires editing the SDF body and re-pinning the
  paired test. Mitigated by the test's narrow assertion (only
  `'draft'`/`'active'` substring check), which survives most schema
  evolutions.
- The `SECURITY DEFINER` pattern requires careful function-owner
  management. The migration explicitly sets owner to a non-`agent_writer`
  role; documented in `docs/architecture/data-model.md`.

**Neutral.**

- The partial UNIQUE constraint on `(parent_version_id, week_iso)` is
  cheap (small index, append-mostly).

## 4. Alternatives considered

- **A. Grant `agent_writer` table-level INSERT on `strategy_versions`
  with a CHECK constraint pinning status to `'draft'`.** Rejected: CHECK
  constraints can be DROPPED by anyone with ownership privilege on the
  table, and adding the constraint at table level rather than at function
  level means the version-number computation and parent-validation logic
  live in the agent's TypeScript — duplicated and bypassable.
- **B. Trigger-based status enforcement** (BEFORE INSERT trigger raises
  on `status <> 'draft'` when `current_user = agent_writer`). Rejected:
  triggers can be disabled by superuser, and the role-discriminated logic
  scatters the boundary across the table's trigger config rather than
  concentrating it in one auditable function.
- **C. Application-layer "the agent's pg client only ever calls one
  query".** Rejected: that is policy, not structure. A second query gets
  added in a fix wave and the boundary collapses with no DB-side
  enforcement.
- **D. Use M12's `mcp_reader` role plus a separate write-only role
  granted only on `strategy_versions(status='draft' partial)`.**
  Postgres GRANT does not support partial-column-value grants (only
  partial-index UNIQUE and CHECK can shape values). Rejected as not
  expressible.
- **E. Insert into a `strategy_versions_draft_inbox` table the engine
  later promotes.** Adds an extra table and a promotion job; the SDF
  pattern already concentrates the gate. Rejected as more moving parts
  for the same property.
- **F. UNIQUE on `(parent_version_id, week_iso)` without the partial
  predicate.** Would also constrain hand-authored versions (where
  `week_iso IS NULL`) to one per `(parent_id, NULL)` — PG treats NULLs
  as distinct so it would still work, but the partial predicate makes
  intent explicit and survives a future `NULLS NOT DISTINCT` choice.
  Kept as documented intent.
- **G. Drop the `parent.status = 'active'` validation.** Would allow
  drafts-of-drafts. Rejected: ADR 0019's promotion gate compares draft
  vs active; comparing draft vs another draft has no well-defined
  semantics in M13. Revisit if M14 introduces multi-step proposal
  chains.

## 5. References

- `docs/plans/archive/M13-execution-plan.md` §"Inputs locked" #5, §W0 items 2–3,
  §W3, §W6a vector 4, §Test strategy items 5–6.
- ADR 0034 §2.1 (sentinel-password rotation pattern), §2.5 (13-table
  whitelist).
- ADR 0016 (strategy version lineage — `name`/`version`/`parent_version_id`).
- ADR 0019 (promotion gate is human-only; agent never writes
  `status='active'`).
- ADR 0035 (agent's structural boundary — this ADR is the DB-side complement).
