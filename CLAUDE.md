# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

Crypto volatility-tracking trading bot (Binance USDT-M Futures, TypeScript/NestJS).
Priority is **conservative, low-risk survival over returns**. Full design and locked
decisions in `docs/plans/00-overview.md` — read it before any non-trivial work.

Use **Claude Opus** (`/model`). The main session orchestrates.

## How to work in this repo

The **main session is the orchestrator** (subagents cannot spawn subagents). For every
non-trivial task, decompose the work, dispatch specialists with `Agent`, run reviewers,
trigger the scribe, and report a summary. **Verify the actual diff after each wave** —
agent summaries describe intent, not reality.

Specialist agents live in `.claude/agents/`. Dispatch in waves:

1. **Serial:** `bot-shared-maintainer` for shared-contract changes (before engine/dashboard).
2. **Parallel:** `bot-engine-nestjs` + `bot-dashboard-react`.
3. **Serial:** `bot-qa-engineer`.
4. **Parallel:** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`.
5. **Serial:** `bot-scribe` to close out docs + work-log.

Each agent's ownership is defined in its `.claude/agents/<name>.md` frontmatter.

## Hard rules

1. Follow the dispatch waves for every non-trivial change. Don't skip reviewers or the scribe.
2. **Read `docs/best-practices/code-conventions.md` before engine code.** Authoritative; overrides generic Clean Code where they conflict.
3. **Read `docs/best-practices/dev-qa-cycle.md` before dispatching any fix or QA wave.** Authoritative process rules — ≤5 items/files per dispatch, adversarial QA, architect on contract touches, reviewer continuity across rounds, paired tests per fix item, orchestrator verifies every diff. Distilled from the M5 retrospective.
4. **Use `context7-mcp` before calling any third-party API** (per `~/.claude/CLAUDE.md`).
5. **Shared types live in `packages/shared/`** — route changes through `bot-shared-maintainer`.
6. Quality over speed. Smaller iterations even if there are more of them. Cycle review/fix until zero blockers, zero highs, majority of mediums resolved.
7. **Branch naming (MUST):** every branch is `<type>/<branch-name>` — `feat/` (feature), `fix/` (bug fix), `hotfix/` (urgent prod fix), `chore/` (core/tooling/docs/deps). Lowercase kebab-case name. `main` is the only unprefixed branch. See `docs/runbooks/ci-gates.md` §0.
8. **NEVER destroy database data or postgres infrastructure (ABSOLUTE).** The following are permanently forbidden without explicit written confirmation from the user in the same conversation turn:
   - `docker compose down -v` or any command with the `-v` / `--volumes` flag
   - `docker volume rm` targeting any postgres volume
   - `DROP TABLE`, `TRUNCATE`, `DELETE FROM` on any production/soak table without a WHERE clause scoped to test data
   - Dropping or recreating the `postgres` compose service or its named volume
   - Any migration rollback (`revert`) in a live/paper soak environment
   - `docker system prune` or `docker image prune` — these can remove the postgres image and named volumes depending on flags
   The soak DB accumulates irreplaceable calibration data. Loss cannot be undone. When in doubt, do nothing and ask.
9. **Always take a dump before any DB or postgres container operation.** Before executing ANY of the following, stop and run a full `pg_dump` first — then show the user the dump path and ask for explicit confirmation to proceed:
   - Any `docker compose` command that restarts or recreates the `postgres` service
   - Any schema migration (up or revert)
   - Any bulk `DELETE` or `UPDATE` touching more than one row
   - Any change to `docker-compose.yml` that affects the `postgres` service or its volumes
   Dump command: `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`
   After the dump, prune old `backup_` files — keep only the **2 most recent**: `ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`
   Do not proceed with the operation until the user confirms the dump completed and they are ready.

## Trading-safety invariants (non-negotiable)

- **No order path bypasses the risk gate.** Strategies/controllers never call the exchange order API directly.
- **Strategies are pure and deterministic** (no `Date.now()`/`Math.random()`/I/O) so backtests reproduce live behavior.
- **No LLM in the live trade loop** — outer-loop only; proposes reviewed, backtested code, never executes.
- **Money is `decimal`, never float.**
- **Exchange keys never committed; key is least-privilege (no withdrawals).**
- **Validate on testnet first**; go live only at minimal size.
- **The VWAP trigger is a detector, not a direction** — fade/follow/skip decided empirically per `flow_type` and regime.
- **No daily profit target.** `skip` is the expected outcome for most triggers; success is risk-adjusted survival.
- **Live starts restricted** ($500–$1,000, 1 position, tier-1 only, isolated margin); caps relax only after confirmed live edge.

## Documentation map

- Overview + locked decisions → `docs/plans/00-overview.md`
- Milestone plans → `docs/plans/`
- **Milestone outcomes (test counts, bugs caught, reviewer rounds, ADR context)** → `docs/milestone-log.md` *(read when debugging regressions or understanding why something was built a certain way)*
- Architecture decisions → `docs/architecture/adr/`
- Code conventions (AUTHORITATIVE) → `docs/best-practices/code-conventions.md`
- Dev + QA cycle rules (AUTHORITATIVE) → `docs/best-practices/dev-qa-cycle.md`
- Testing → `docs/best-practices/testing.md`
- Tech debt + deferred items → `docs/tech-debt.md` *(HIGH = go-live blockers, MEDIUM = feature gaps, LOW = cosmetic/refactor)*
- Work log → `docs/work-log.md`

## Status

**Current status:** M23 done, M15 next — full milestone history, test counts, and go-live gates in `docs/milestone-log.md`.

**M23 — Market-stress adaptive auto-resume (DONE):** Code-only fix (no migration, no DB write at rest). Breadth-triggered `market_stress` halts now auto-resume after `MARKET_STRESS_RESUME_CLEAR_TICKS=3` consecutive clean global-breadth ticks in the inner hysteresis band ([20,80] at distance ≤30). Engage threshold unchanged (|breadth−50| ≥ 40). Per-day re-halt cap: 3rd breadth halt → full-day lock reasserts. `halt_reason` now carries `market_stress:<leg>` suffix (`:breadth` is the only resume-eligible leg; all others and loss halts stay full-day locked). New `MARKET_STRESS_AUTO_RESUME_ENABLED` boot flag: paper-default-on, live-default-off. 116 new tests green. Review: 2 rounds — zero blockers, zero highs at close. **Post-deploy:** pg_dump before restart; stale-halt inspection (`halt_reason LIKE 'market_stress%'`); 10-min smoke; backtest over soak window (report stats for trades within 30 min of auto-resume); 14-day paper soak before live activation.

**M22 — Depth-floor recalibration (DONE):** Code-only fix (no migration, no DB write). Recalibrated `COIN_DEPTH_FLOOR_10BPS_USDT` from M19 round numbers to book-consumption-ratio anchors: `{ TIER_1: 10_000, TIER_2: 2_500, TIER_3: 2_000 }` (one-sided, $250 max order). Soak evidence: 10 rejects on 2026-06-04; 7 unblocked at $3,468–$9,174; 3 still blocked at $529/$681/$2,321. ADR 0004 §6a superseded in place; §6b breadth-distance corrected 30→40 (drift fix). 23 new tests green. Two MEDIUM tech-debt entries added (volume-only tier ranking; entry-vs-exit depth gap). Review: 2 rounds — zero blockers, zero highs at close. **Post-deploy:** pg_dump before restart; no clearHaltForDate needed (depth guard is a per-decision skip, not a halt); 10-min smoke; funnel-mix check 24–48h; 14-day realized-vs-modeled slippage telemetry mandatory before scale-up (ADR §6a calibration condition).

**M21 — Index-shock horizon alignment (DONE):** Code-only fix (no migration, no DB write). Switched BTC and ETH index-shock legs to 5-minute horizon. BTC: `stress_btc_1m_shock_pct` (1m strategy param, 1.0%) → `STRESS_BTC_5M_SHOCK_PCT = 1.5` (engine const). The 1m BTC leg was empirically inert (peak 0.56% in soak vs 1.0% floor). ETH: `STRESS_ETH_5M_SHOCK_PCT` raised 2.0 → 2.5 (only near-event was 2.12%; 2.5% is slightly conservative per 1.2–1.5× ETH beta relative to BTC). Atomically updated `hasInvalidStressInputs` guard from `btc_1m` to `btc_5m` (fail-closed). Deprecated 1m params retained for replay compatibility. ADR 0004 §6c added. 191 tests green. Review: security/logic/clean-code CLEAN; quant HIGH (backtest BTC candle-return vs live rolling-window move divergence) logged as MEDIUM tech-debt (acceptable fail-direction: fewer false halts, not missed ones; expected to resolve from post-deploy soak telemetry per ADR 0004 §6c). Zero blockers, zero highs, zero mediums at close. **Post-deploy:** stale-halt inspection (if `is_halted=true` under old thresholds and tape calm, clear via `clearHaltForDate`), 10-min smoke, 14-day near-miss telemetry watch.
