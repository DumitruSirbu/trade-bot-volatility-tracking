# Tech Debt

Deferred items from milestone close logs. Prioritised: **HIGH** = blocks M15 go-live or has production impact, **MEDIUM** = feature or correctness gap, **LOW** = cosmetic/refactor/nit.

Items resolved or no longer applicable should be removed. New items added at the bottom of their priority group with the originating milestone.

## HIGH — Go-live blockers

| Item | File / Location | Origin | Notes |
|------|----------------|--------|-------|
| Verify LIVE master-account `/sapi/v1/account/apiRestrictions` response shape — sub-account and master-account shapes diverge | `KeyPermissionAssertionService` | M11a | Predicate could silently pass unsafe key if master-account omits a field; must re-validate Binance docs vs real endpoint |
| `risk_state.updated_at` true newer-wins upsert (W2.4) | `RiskStateRepository` | M11 | Pre-soak blocker; depends on TESTNET validation |
| `AuthFailureReasonEnum.BAD_AUDIENCE` — verifier currently uses `BAD_SCOPE` for audience mismatch | `apps/engine/src/auth/` | M13 | Live-smoke gap |
| Engine auth CLI token TTL cap is 900s — weekly agent runs need automated minting or long-lived-token issuance | `apps/agent/` | M13 | Agent will fail after 15 min without token refresh |
| Branch protection payload NOT YET APPLIED by repo owner | GitHub repo settings | M14 | Must apply via `docs/runbooks/ci-gates.md` before any live merge |

## MEDIUM — Feature / correctness gaps

| Item | File / Location | Origin | Notes |
|------|----------------|--------|-------|
| M15 soak evaluator wave (CRN tape, TOST calibration, sample-size pre-flight, lowFidelity rankings) | `docs/plans/M11a-local-soak.md` | M11a | Gate before M15 cloud go-live |
| `HaltSourceEnum.PAPER_DRAWDOWN` / `PAPER_RECONCILIATION_DRIFT` dedicated values | `packages/shared/` | M11a | Shared change deferred M15 |
| `IExchangeOrderSnapshot` → shared `IOrder` full migration (dual-shape via D2+D14 ports today) | `apps/engine/` | M11a | |
| Simulator-config-hash real source (sentinel today) | `apps/engine/` | M11a | R3.1 |
| Multi-value filter server-side `IN (...)` — currently client-side page-scoped for multi-select | `DecisionRepository.findPage`, `MetricsController` | M11a soak | Extend to accept array of actions/symbols |
| Strategy-comparison UI (walk-forward OOS, bootstrap CIs, per-regime tables, charting) | `apps/dashboard/` | M11 | Blocked pending depth-aware + lowFidelity extension |
| LLM review/QA/scribe agents wired into CI on PRs (phase-2) | `.github/workflows/` | M14 | User explicitly deferred; proposed future pipeline |
| Code coverage threshold gate (non-blocking advisory) | CI config | M14 | Until baseline defined |
| Dependabot/Renovate automation for supply-chain | `.github/` | M14 | |
| Short-position funding-sign boundary test | `RiskGateService` tests | M14 | Optional belt-and-suspenders; math verified M4/M6 |
| SDF idempotency pre-check before LLM call (cost optimization) | `apps/agent/` | M13 | Detect `week_iso` re-fire early |
| `pickTopSymbols` hardcoded to `['BTCUSDT', 'ETHUSDT', 'SOLUSDT']` | `apps/agent/` | M13 | Needs engine per-symbol trade-count on `IPerformanceByVersionView` |
| `assertSharedRunConfig` only checks window equality | `apps/agent/` | M13 | Needs `simulatorConfigHash` + `seed` on `IBacktestReport` |
| 6 ADR 0019 promotion-gate criteria NOT_AVAILABLE (5, 7, 8, 9, 10b, 11) | `apps/agent/`, `apps/engine/` | M13 | Requires engine extensions to `IBacktestReport`/`IPerformanceByVersionView` |
| MCP_ENGINE_CMD realpathSync TOCTOU (spawn block-level symlink race) | `apps/mcp/` | M13 | |
| GRANT CONNECT identifier quoting (Postgres reserved-word safety) | DB migrations | M13 | |
| mcp_reader NOLOGIN-until-rotate (password management policy) | DB role setup | M13 | |
| Missing index on `decisions(position_id, ts)` | DB schema | M13 | Query perf gate |
| `AuthFailureReasonEnum.BAD_SIGNATURE` split (W1.5) | `apps/engine/src/auth/` | M11 | |
| `LiveGateway` `AppConfigService` injection + parser parity test (W2.5) | `apps/engine/` | M11 | |
| `HKDF` cursor sub-key derivation (W1.7) | `apps/engine/` | M11 | |
| `revoked_jti` TTL prune + age-floor (W1.6) | `apps/engine/` | M11 | |

## LOW — Cosmetic / refactor / nit

| Item | File / Location | Origin | Notes |
|------|----------------|--------|-------|
| Extract shared `WsAuthAdapter` teardown helper used by both `LiveGateway.spec.ts` and `LiveGateway.adversarial.spec.ts` | `apps/engine/tests/ws/` | M17 post-ship | DRY — both specs `afterEach` call `adapter.onModuleDestroy()` identically |
| `buildLibpqEnv` decodeURIComponent on malformed percent-encoded DATABASE_URL can throw unwrapped | `apps/engine/src/backup/DbBackupScheduler.ts` | M17 | Operator-trusted env var; not wrapped in DbBackupFailedException |
| On pipeline rejection while pg_dump running, child process not explicitly killed | `apps/engine/src/backup/DbBackupScheduler.ts` | M17 | stdout teardown self-terminates; LOW risk |
| `emitHaltChanged` has 5 params; needs `IEmitHaltChangedParams` DTO | `HaltService.ts:218` | M11a soak | CC-M3 |
| `writeAudit` anonymous 11-field inline type; needs named `IWriteAuditParams` | `HaltService.ts:323` | M11a soak | CC-M4 |
| `engageHalt` (58 lines) and `resume` (44 lines) exceed size guideline; extract private helpers | `HaltService.ts:106,165` | M11a soak | CC-M5 |
| `utcDateString` duplicated in `HaltService` and `MetricsController`; promote to `common/utils/dateUtils.ts` | `HaltService.ts:455`, `MetricsController.ts` | M11a soak | |
| `applyClientFilter`/`toServerFilter` duplicated in component and spec; extract to `decisionsFilterUtils.ts` | `DecisionsFeed.tsx`, `DecisionsFeed.spec.tsx` | M11a soak | |
| `notePragmaticAutoClear`/`notePragmaticTransition` near-identical; extract `buildSyntheticAudit()` | `HaltService.ts:253–289` | M11a soak | |
| Duplicated `isHalted() ? 'HALTED' : 'RUNNING'` ternary; extract `currentStateLabel()` | `HaltService.ts:106,166` | M11a soak | |
| `wasAlreadyHalted` context-dependent boolean flag arg; rename to `isIdempotent` | `HaltService.ts:218` | M11a soak | |
| Dead methods in `FakeControlAuditRepository` (`findLatest`, `findHistoryPage`) | `HaltService.resume.spec.ts:37` | M11a soak | |
| `RiskHaltStatePortAdapter` barrel export in `risk/service/index.ts` is misleading; add comment | `apps/engine/src/risk/service/index.ts` | M11a soak | ControlModule-only provider |
| `COLUMN_HELP` 70-line JSX constant inline; extract to `decisionsFeedHelpContent.tsx` | `DecisionsFeed.tsx` | M11a soak | |
| MultiSelect inline `onClick` arrow recreates closure; extract as `toggleOpen` useCallback | `multi-select.tsx:80` | M11a soak | |
| Add comment explaining `TOOLTIP_ESTIMATED_HEIGHT = 400` derivation | `tooltip.tsx:18` | M11a soak | |
| `windowDays` Math.floor vs round (cosmetic quant) | `apps/analysis/` | M13 | |
| Paired test for `analysisValidation.ts` + `BacktestCliArgError` own file | `apps/mcp/` tests | M13 | |
| `McpToolErrorKindEnum` as proper TS enum | `apps/mcp/` | M13 | |
| Control-flow spacing mass edit (~30 spots, formatter pass) | `apps/engine/` | M13 | |
| `waitForChild`/`buildRuntime`/`listPositions` function-size refactors | `apps/mcp/` | M13 | |
| `verifyBearer`/`runUnderWallclock`/`runBoundaryGuard` function-size extractions | `apps/agent/` | M13 | |
| arg-count > 2 DTO refactors in agent (other call sites beyond `composeMarkdown`) | `apps/agent/` | M13 | |
| `void param;` suppressions cleanup (3 in `runWeeklyLoop` + `main`) | `apps/agent/` | M13 | |
| ESLint disable noise (5 pragmas in agent) — eliminable via scoped override | `eslint.config.js` | M13 | |
| pino logger redact paths may need broadening as sub-objects appear | `apps/engine/` | M13 | |
| `notePragmaticTransition` clamps + try-block order + `startOfRiskDayMs` init + `lastTransitionAuditId` JSDoc (W2.6) | `HaltService.ts` | M11 | |
| AUTH token TTL comment (W2.8) | `apps/engine/src/auth/` | M11 | |
| Cache-Control on halt/history endpoints (W2.7) | `HaltController.ts` | M11 | |
| pino-pretty dev-arg fallback (W2.9) | `apps/engine/` | M11 | |
| `auth_tokens` table confirmed stateless — `revoked_jti` sweep cosmetic (W1.6 follow-up) | `apps/engine/` | M11 | |
| `BaseRepository` uuid-PK widening (cosmetic + scaling) | `apps/engine/` | M11 | |
