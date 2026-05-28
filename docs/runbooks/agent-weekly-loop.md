# Agent Weekly Loop Runbook

Operational pre-flight + day-2 ops for the weekly outer-loop agent
(`apps/agent/`). The agent runs once per week as a batch job inside the
`bot-agent` container, triggered by the ofelia cron sidecar
(`bot-agent-cron`). See ADRs 0035 (structural boundary), 0036
(`agent_writer` SDF), 0037 (Vercel AI Gateway), and 0038 (MCP HTTP
transport).

## Overview

The agent runs once per ISO-week. Each run:

1. Pulls last-week performance + decisions via the MCP HTTP transport
   (`AGENT_MCP_URL`, bearer `AGENT_MCP_BEARER`).
2. Prompts an LLM via the Vercel AI Gateway (`AI_GATEWAY_URL` /
   `AI_GATEWAY_API_KEY`, hard-capped at `AI_GATEWAY_MAX_USD_PER_RUN`).
3. Drafts a strategy version via the dedicated `agent_writer` SDF — a
   single `status='draft'` row, never `status='promoted'`.
4. Writes a markdown + JSON report to `./reports/agent/<week-iso>/`.
5. Appends an `agent_run_history` row capturing terminal state, model
   id, draft id, bootstrap-CI bounds, and the promotion-gate decision.

The agent **never** trades, **never** promotes drafts, and **never**
talks to the exchange. Promotion of a draft is an operator action via
the dashboard.

## Bootstrap (one-time)

1. **Mint an MCP bearer** for the agent (7-day TTL, scoped to MCP):

   ```bash
   pnpm --filter @bot/engine auth mint-token \
       --aud mcp --sub agent --ttl 7d
   ```

   Copy the printed token into `AGENT_MCP_BEARER` in `.env`.

2. **Rotate `AGENT_DB_PASSWORD`** from its migration-sentinel value.
   Generate a strong secret and ALTER the role:

   ```bash
   openssl rand -base64 32   # capture the output
   docker exec -i trade-bot-postgres \
       psql -U "$DB_USER" -d "$DB_NAME" \
       -c "ALTER ROLE \"agent_writer\" PASSWORD '<new-secret>';"
   ```

   Set `AGENT_DB_PASSWORD=<new-secret>` in `.env`.

3. **Configure the AI Gateway**: set `AI_GATEWAY_URL`,
   `AI_GATEWAY_API_KEY`, and optionally lower
   `AI_GATEWAY_MAX_USD_PER_RUN` (default `2.00` USD).

4. **Create the report directory** on the host (gitignored, owned by
   the user running compose):

   ```bash
   mkdir -p ./reports/agent
   ```

## Start the stack

The agent + cron sidecar are gated behind the `agent` compose profile,
so a default `docker compose up` skips them entirely.

```bash
docker compose --profile agent up -d
```

`bot-agent` runs `sleep infinity` as PID1 (the weekly job is launched
into the container by ofelia via `docker exec`). `bot-agent-cron`
schedules the next run for Sun 00:00 UTC.

## Manual trigger

Operator-driven re-run of a specific week (idempotent — the SDF's
unique key on `(parent_version_id, week_iso)` makes re-runs safe):

Dry-run (writes nothing, prints the report to stdout):

```bash
docker compose --profile agent exec bot-agent \
    node dist/main.js --week-iso 2026-W22 \
    --parent-version-id 12 --dry-run
```

Live run (persists the draft + history row, writes the report files):

```bash
docker compose --profile agent exec bot-agent \
    node dist/main.js --week-iso 2026-W22 \
    --parent-version-id 12
```

The in-process lockfile (`/tmp/bot-agent.lock`) prevents an operator-
initiated run from overlapping the cron-initiated run; the
late-comer exits 0 with `LOCK_HELD`.

## Inspect reports

The host directory `./reports/agent` is mounted into the container at
`/app/reports`.

```bash
ls reports/agent/                              # weeks
ls reports/agent/2026-W22/                     # drafts
cat reports/agent/2026-W22/<draft-id>.md       # markdown report
jq . reports/agent/2026-W22/<draft-id>.json    # structured payload
```

## Inspect history

`agent_run_history` captures one row per completed (or failed) run:

```sql
SELECT
    week_iso,
    parent_version_id,
    draft_version_id,
    model_id,
    terminal_state,
    failure_reason,
    passes_promotion_gate,
    bootstrap_ci_lo,
    bootstrap_ci_hi,
    started_at,
    finished_at
FROM agent_run_history
ORDER BY started_at DESC
LIMIT 20;
```

Common `terminal_state` values: `SUCCESS`, `FAILED`, `SKIPPED_HALTED`,
`SKIPPED_NO_DATA`. Common `failure_reason` values: `WALLCLOCK_EXCEEDED`,
`LOCK_HELD` (rare — only when the lockfile cannot be released),
`EGRESS_VIOLATION`, `GATEWAY_BUDGET_EXCEEDED`.

## Promote a draft

The agent does **not** promote drafts. Promotion is an explicit
operator action via the dashboard — read the markdown report, inspect
the draft row in `strategy_versions`, then promote from the UI. There
is no CLI shortcut: promotion is intentionally gated behind the
dashboard's auth flow.

## Halt-flag interaction

When the engine's kill-switch is engaged, the agent skips the run and
writes `terminal_state='SKIPPED_HALTED'` to `agent_run_history`. No
LLM call is made, no draft is created, no report is written. The next
scheduled run re-checks the halt flag and proceeds normally once the
operator clears it.

## Bearer rotation

`AGENT_MCP_BEARER` is minted with a 7-day TTL. Plan to rotate weekly.
Re-mint with the same command as in Bootstrap, update `.env`, then
recreate the container so it picks up the new env:

```bash
docker compose --profile agent up -d --force-recreate bot-agent
```

The ofelia sidecar does not need recreating — it doesn't read agent
env, only labels.

## Troubleshooting

- **`LOCK_HELD`** in the logs — a prior run is still in flight (or the
  lockfile wasn't cleaned up). Check `docker compose --profile agent
  exec bot-agent ls -la /tmp/bot-agent.lock` and the running `node`
  process. The lock auto-expires after 90 min staleness.
- **`WALLCLOCK_EXCEEDED`** — the run blew past the 45-min wallclock
  (`AGENT_WALLCLOCK_MS_OVERRIDE` overrides for tests only). Inspect
  the report dir for partial output; the history row is recorded with
  `draft_version_id=null`.
- **`EGRESS_VIOLATION`** — the agent attempted to talk to a host
  outside the allow-list (MCP, AI Gateway, Postgres). Check the most
  recent log lines for the offending hostname; this is almost always
  a misconfiguration of `AGENT_MCP_URL` or `AI_GATEWAY_URL`.
- **Bearer rejected** — token expired or `AUTH_HMAC_SECRET` rotated.
  Re-mint per "Bearer rotation" above.
- **Cron silent** — `docker logs trade-bot-agent-cron` shows the
  schedule ofelia loaded. Verify the labels on `bot-agent`
  (`docker inspect trade-bot-agent --format '{{json .Config.Labels}}'`).

## References

- ADR 0035 — agent / engine structural boundary.
- ADR 0036 — `agent_writer` SDF (draft-only write surface).
- ADR 0037 — Vercel AI Gateway integration + per-run cost cap.
- ADR 0038 — MCP HTTP transport + bearer auth.
- Plan: `docs/plans/M13-execution-plan.md` §W5.
- Entry point: `apps/agent/src/main.ts`.
