# M9 — Observability, control & read API

**Goal:** Know what the bot is doing, halt it instantly, and expose a read API the
dashboard will consume.

**Depends on:** M6 (positions), M5 (execution honors halt).

## Tasks

- **Startup schema validation (prerequisite gate).** Before market-data persistence pipeline starts, verify all TypeORM migrations are applied or expected tables exist; fail-fast with alarm instead of booting silently and swallowing persistence writes. Observed in M2 testnet: engine ran against reverted/unmigrated DB, logged schema-not-found errors but booted normally, creating silent data gaps (ADR 0002 §6). Validate at PersistenceModule bootstrap; throw rather than degrade.
  - *Output:* engine refuses to boot if required schema is missing; loud alarm instead of silent data loss.

- **Auth FIRST (prerequisite gate).** Stand up the auth guard before any endpoint is wired. **Short-lived bearer tokens (or mTLS) from the secret manager, with server-side revocation** — define TTL and a revocation path; no static/basic credentials, none committed. A CORS allow-list restricts origins to the dashboard only. No endpoint — especially halt — exists before the guard is in place.
  - *Output:* every endpoint rejects unauthenticated/cross-origin requests; a revoked token stops working immediately.
- **Telegram alerts (strictly outbound)** on open/close/error/halt + a daily PnL summary (aligned to the UTC risk-day). **No inbound command handling** — Telegram is never a control path. Redact secrets; no keys/tokens in messages.
  - *Output:* a phone message on every trade and error, outbound-only, no sensitive leakage.
- **Kill switch.** Authenticated endpoint over the M0 halt flag; execution refuses new entries when halted. **Flatten-on-halt is a config flag with a stated default.** The endpoint is **rate-limited** and every toggle is **audit-logged** (actor, timestamp, source IP).
  - *Output:* one action stops new trading; honored by ExecutionModule; toggles are throttled and audited.
- **Surface risk halts + model divergence.** Expose and **alert via Telegram** on the M4 **global market-stress halt** (BTC/ETH shock, breadth, same-bar trigger count, OI/funding/spread extremes) and the **model-divergence kill switch** (live-vs-modeled slippage gap; realized-vs-expected distribution drift). These must be visible in the read API and push an alert when they engage.
  - *Output:* engaging either halt produces a Telegram alert and a read-API state change; both are audit-logged.

- **Read API (REST).** Snapshots: open positions, PnL, recent decisions, performance-by-version, account equity. Authenticated; least-disclosure payloads.
  - *Output:* authenticated REST endpoints returning current state.
- **Live updates (WS/SSE) gateway.** Push position/PnL/decision updates to authenticated subscribers. **Validate the token at handshake AND re-validate on expiry** — a long-lived connection authenticated once must not stream forever; force re-auth on token expiry/revocation.
  - *Output:* a WS client receives live ticks only while holding a valid, unexpired token.

## Definition of done

The auth guard gates all endpoints from creation; phone alerts fire on trades; the
bot can be halted in one authenticated, rate-limited, audited action; an
authenticated, CORS-restricted API streams live state, verified with a WS client.

## Outcome

**Completed:** W0–W6 shared contracts (7 enums + 14 interfaces + READ_API_VERSION constant); W1 startup schema-validation gate (PHASE 0, fail-fast on missing migrations, stderr block printed always); W2 AuthGuard HS256 bearer + revoked_jti + AuthCorsInterceptor + CLI issue/revoke; W3 HaltController (POST halt/resume, GET halt/history) + HaltService + HaltRateLimiter (5/60s per sub) + HaltStateRestoreService (PHASE 3, newer-wins halt, wins tie-break); W4 ReadApi REST controllers + entity→DTO mappers + HMAC-tamper-guard CursorCodec + HealthController; W5 socket.io LiveGateway namespace /live + 4 rooms (POSITIONS/DECISIONS/PNL/CONTROL) + WsAuthAdapter handshake + sweeper + PerSocketQueue backpressure + PnL throttle + position coalescer; W6 TelegramAlertSink (outbound-only) + AlertRedactor + AlertRateLimiter (30/min + per-symbol coalesce) + DailyPnlSummaryScheduler (UTC midnight) + RiskListeners (risk-halt + model-divergence alert-only path under Option β); W6.1 M4 RiskGateService bus emits for market-stress + model-divergence (read-only side-channel; gate decision byte-identical).

**ADRs:** 0020 auth+CORS, 0021 kill-switch contract, 0022 read API surface, 0023 WS/SSE gateway, 0024 Telegram alerts, 0025 startup schema-validation gate. Updated through R1+R2 with §M9 R1 contract adjudications.

**Review history:** R1 (4 reviewers parallel — Security 2 blockers + 6 highs; Logic 2 blockers + 4 highs; Clean-code 8 violations; Quant 1 blocker + 4 highs). Architect adjudicated 6 contract questions (halt SoT → Option β; wasAlreadyHalted; DTO nullability widen; CursorCodec audit history; flatten default via AppConfigService; CORS single source). 6 fix waves (#11 shared bump; #12 halt SoT split; #13 DTO nullability + unrealizedPnlPriceUsd/Funding rename; #14 security blockers + auth ordering; #15 clean-code; #16 misc mediums). R2 (Logic 10 R1 items resolved, 2 new highs [one HaltStateRestoreService boundary inverted]; Security all resolved; Clean-code clean; Quant 1 high remaining [winRate nullability]). 2 R2 fix waves (#17 shared winRate + 2 engineer dispatches). R3 (narrow: Security clean, Logic clean [2 new LOWs acceptable], Quant clean). **Final state: zero blockers, zero highs.**

**Live-app smoke (10h close):** Caught 2 production bugs the test suite missed: (1) AlertModule⇄ControlModule forwardRef cycle → ALERT_SINK Symbol DI undefined → boot fail (fix: AlertSinkModule leaf extraction, task #18 fix wave). (2) LiveGateway.liveSockets() called `this.server.of(...)` but @WebSocketGateway injects Namespace (no `.of()`) → sweeper crashed 30s (fix: 2-line lambda + regression test). Schema-gate manifest had 3 wrong column references (funding_rates.funding_rate, transactions.symbol, risk_state.updated_at) — engineer fixed + integration spec asserting manifest vs `information_schema.columns`. Process stderr before exit so operator sees failure. After fixes: engine ran ~9h on Binance testnet, EXECUTION_MODE=live, ACCOUNT seed $5000. Activity: 43 decisions written; 14 "open" candidates; 0 positions opened; 2 programmatic market-stress halts engaged. Reject reasons: sl_outside_liquidation 7×, exposure_cap_per_coin 2×, market_stress 2×, spread_too_wide 2×, global_halt 1×. Behavior consistent with CLAUDE.md "conservative survival" philosophy. 0 crashes, ~80MB RSS.

**Test count:** 1,967 tests passing, 116 test suites passed; 39 pre-existing Postgres-credential failures on M2 integration specs (migration.roundtrip, market-data repository, tick-partition services), unrelated to M9. M9 tests: 6 focused new suites (control + read + ws + auth + halt + risk-listeners); full regression pass required.

**Deferred to M10/M11 (pre-M10 follow-ups):**
- M11: AuthFailureReasonEnum.BAD_SIGNATURE enum split.
- M11: BaseRepository<T> widening to `{ id: number | string }` for uuid-PK repos.
- M11: risk_state.updated_at column for true newer-wins comparison.
- M11: LiveGateway AppConfigService injection (decorator can't inject; reads env at connect-time via parser identical to AppConfigService.parseCorsAllowlist).
- M11: HKDF cursor sub-key derivation so auth-secret rotation doesn't invalidate paginated sessions.
- M11: revoked_jti TTL prune sweep.
- M11: notePragmaticTransition: clamp occurredAtMs (negative/far-future guard) + try-block reordering so flag-flip-throw doesn't skip state note + initialize startOfRiskDayMs to POSITIVE_INFINITY when riskState null + empty-id sentinel JSDoc on IKillSwitchState.lastTransitionAuditId.
- M11: AUTH_TOKEN_DEFAULT_TTL_SEC vs AUTH_TOKEN_MAX_TTL_SEC clarifying comment.
- M11: Cache-Control no-store on `GET /v1/control/halt/history` (only POSTs set it; logic R2 noted; engineer wired interceptor on Positions+Metrics but ControlController.history still relies on POST-only header).
