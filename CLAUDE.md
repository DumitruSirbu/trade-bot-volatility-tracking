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
- Architecture → `docs/architecture/`
- Code conventions (AUTHORITATIVE) → `docs/best-practices/code-conventions.md`
- Dev + QA cycle rules (AUTHORITATIVE) → `docs/best-practices/dev-qa-cycle.md`
- Testing → `docs/best-practices/testing.md`
- Work log → `docs/work-log.md`

## Status

**M0 — Foundation & scaffolding:** DONE (pnpm + Docker + NestJS 11 + TypeORM + event bus + halt-flag + money helpers).
**M1 — Exchange & market data:** DONE (ccxt/Binance testnet, MarketDataModule, shared trigger, 251 tests, 3 review rounds, zero blockers).
**M2 — Persistence & data model:** DONE (13 domain-owned entities, 353 tests, reversible migrations + 90-day partitioned tick_aggregates, 2 review rounds + post-review smoke test, zero blockers, testnet persistence verified).
**M3 — Strategy engine:** DONE (4 pure strategies v0–v3, registry + config-selected active version, orchestrator stamps flow_type/signal_score/event_id and writes dry-run decisions, 202 tests, 2 review rounds, zero blockers).
**M4 — Risk management:** DONE (bypass-proof risk gate, 3-slot position model, BTC-correlated single-candidate, daily/weekly loss windows, in-flight reservation ledger, funding suppression + flow rules, spread/liquidity/SL/time-stop/cooldown/market-stress/consecutive-loss/overtrading/OI/tier-3 gates, isolated-margin default, model-divergence kill-switch, 700 tests, 2 review rounds, zero blockers).
**M5 — Execution (testnet):** DONE (ExecutionModule idempotent open/add/reduce/close, marketable-limit-IOC + post-only-maker + reduce-market policies, partial-fill FillAccumulator, LocalProtectiveMonitor arm/disarm, ccxt testnet, EXECUTION_MODE config, 898 tests, 5 review rounds, zero blockers, testnet smoke runbook documented).
**M5.5 — Adversarial backfill (pre-M6 hardening):** DONE (2 production bugs fixed in M2, 172 adversarial tests added across M1–M5, dev-qa-cycle validation complete, 3-round strict cap held, zero blockers/highs at close, pre-M6 deferred items catalogued).
**M6 — Position management & reconciliation:** DONE (8 implementation waves: W0 shared-contracts, W1 state-machine + transition, W1.5 PENDING_OPEN entry, W2 SubscriptionRetainer, W3 LocalProtectiveMonitor eval, W4a+W4b reconciliation + 6 drift cases + mutation primitives, W5 funding + PnL, W6 PositionInstrumentor, W7 account_snapshots, W8 crash-recovery 10-phase pipeline; 5 review rounds with 8 contract adjudications; 78 adversarial tests zero production bugs; 851 focused tests; R5 clean all reviewers; zero blockers/highs at close; 3 pre-go-live blockers flagged for M7 validation; deferred reservation-linkage + cosmetic reshims + tech-debt to M7 W0).
**M7 — Backtesting & performance:** DONE (BacktestRunnerService replay loop, fill simulator (tier slippage, latency, missed-fill, intra-bar stops), PnL/funding/slippage accounting, Sharpe/Sortino/drawdown metrics, IBacktestReport; 82 new tests, 2 review rounds, zero blockers/highs at close; known approximations catalogued: lowFidelity always true until depth-aware extension, entry notional for funding, force_close exit reason pending enum, cross-symbol metrics zeroed, missing BTC bars marked low-fidelity; deferred OrderPolicyRouter injection + eventAnchoredVwap reconstruction + force_close enum + depth-aware extension to M8).
**M8 — Strategy versioning & comparison:** DONE (walk-forward OOS splits, paired circular-block bootstrap n=10k 95% CI on expectancy-per-unit-risk, per-regime metrics, 12-criterion all-of promotion gate ADR 0019; direction decision v0/v1/v2/v3 now data-backed; W0 force_close enum + M2 partition rollover, W1 OrderPolicyRouter injection, W2–7 stats/comparison/promotion/CLI, W8 59 adversarial tests; 3 fix rounds 0 blockers/highs at close; ADRs 0016–0019; 264 focused tests + 254+ adversarial/integration green; deferred M8 W6.1 criteria 7+9, M9 depth-aware, M11 eventAnchoredVwap + CLI auth).
**M9 — Observability, control & read API:** DONE (startup schema-validation gate, auth guard HS256 bearer + revoked_jti, HaltController + rate-limit + audit, ReadApi REST + CursorCodec, socket.io /live gateway, TelegramAlertSink outbound-only, DailyPnlSummaryScheduler, RiskListeners; ADRs 0020–0025; 3 review rounds zero blockers/highs; live-app 10h smoke caught 2 production bugs + schema validation fixes; zero crashes; deferred M11 follow-ups catalogued).
**M10 — Dashboard:** DONE (Vite + React 19 + TS + Tailwind v4 + shadcn/ui + TanStack Query; login endpoint (ADR 0027 bootstrap-secret), LoginRateLimiter + auth, read views + WS cache merge, kill-switch UI; engine Dockerfile + nginx containerisation; ADRs 0026–0027; 3 review rounds zero blockers/highs; live-app compose smoke verified login + real-time updates + XFF spoof rejection; 170 engine tests + 152 dashboard tests green).
**M11a — Local soak hardening (PAPER mode):** R0–R4 + live-smoke fix wave DONE. Complete end-to-end PAPER-mode implementation (engine-local paper-trading against live Binance market data + M7 `FillSimulatorCore` + deterministic HMAC-seeded fills + boot-mode HMAC chain + nullity probe + reconciliation). **PAPER architecture (D1–D17):** shared ports (`IExecutionClient`, `IAccountStateSource`) + typed DTOs (`IOrder` with `reduceOnly`, `IPosition`, `IBalance`, `IFunding`, `IOrderIntent`); engine adapters (`CcxtExecutionClient`, `ExchangeAccountStateSource`, `PaperExecutionClient`, `PaperAccountStateSource`); `paper-mode/` module with capability guard, persistence (9 tables: `paper_account_state`, `paper_account_state_history`, `paper_account_state_meta`, `paper_account_snapshots`, `paper_simulator_idempotency`, `paper_state_audit`, `paper_crn_tape`, `boot_mode_history`, `boot_mode_chain_rotations`), HMAC-chained audit, deterministic fill simulator (`StreamingFillAdapter`), drawdown handler, funding service (D4 sign convention), reconciliation adapter (D12 CRITICAL on drift), nullity probe (D13 two-call + capability preflight), mark-price WS bridge (D5 throttled MTM). **Boot-mode-history HMAC chain** (D6 + D7): append-only typed rows, transition matrix with single-use tokens, crypto key subkey per purpose, sequence-numbered HMAC binding to prevent clock-skew attacks. **Mode-aware key-permission assertion** (D8 Fallback Profile LOCKED): PAPER on dedicated zero-balance sub-account with `enableFutures: true` only, gated by D13 probe invariants at boot (zero balance, zero positions, zero open orders, non-empty IP allow-list, non-null trading authority, no transfer permissions). **FillSimulatorCore extracted to shared** (D15, M7 numerical-equivalence regression test green). **Engine-shape execution port** (`IEngineExecutionClient` / `ENGINE_EXECUTION_CLIENT` dispatch token): `ExchangeOrderSubmitter` + `ProtectiveOrderAttacher` env-dispatch to `PaperExecutionClient` under PAPER (compile-time guarantee: no live-order leak via RateLimitPolicyService import guard). **Auth/bootstrap DI cycle fixes:** 3 leaf-module extractions (BootModeHistoryModule, KeyPermissionAssertionService, DerivedKeyService reshuffle). **Test counts:** ~2,384 unit tests green (658 M11a-new adversarial tests across R0–R3 cycles); 12 pre-existing PG-integration suites unaffected (require local Postgres). **Reviewer cycle:** R0 (doc-only) → R1 (3 fix waves, HMAC chains + boot sequence) → R2a (2 fix waves, IAccountStateSource + IExecutionClient ports) → R2b (1 fix wave, paper account state atomic migrations) → R2c (1 fix wave, FillSimulator + funding + MTM) → R2d (1 fix wave, reconciliation paper cases + NullityProbe) → R3 (audit + 11 new tests, module-graph + atomicity + causality + TOST + CRN) → R4 (4 reviewers, 1 consolidated fix wave + 1 shared lowFidelity follow-up) → **post-R4 live-smoke fix wave** (4 CRITICAL bugs: HMAC-chain manager.save() INSERT...RETURNING atomic capture, Binance `/sapi/v1/account/apiRestrictions/ipRestriction` discontinued endpoint dropped, sub-account response-shape defaults corrected, boot alert severity fixed from CRITICAL to INFO) all clean at close. **Blockers/Highs resolved:** R0 D8 endpoint-accessibility blocker (Fallback Profile design locked); R1 3 blockers + 5 highs (boot sequence, HMAC chain, Fallback Profile predicate); R2a 0 blockers + 0 highs; R2b–R2d 0 blockers + 0 highs per sub-wave; R3 audit green; R4 0 blockers + 0 highs; post-smoke: 4 bugs caught + fixed, engine now boots cleanly end-to-end. **Addendum merged into `M11a-local-soak.md`:** W1.1 reworded to PAPER design (D1–D17 locked decisions folded into new "PAPER-mode architecture" section with all anchor IDs preserved); D10 closed-trade counting integrated into "Minimum trade count"; lowFidelity downgrade + M11b gate hardening integrated into "Reduced evaluation gate"; pre-soak sanity step (asymmetric TOST D10) + sample-size pre-flight integrated into W4.4; TESTNET pre-M11b drill section added before exit criteria; Definition of Done updated for PAPER + TESTNET gates; operator runbook step added for IP allow-list verification (Binance UI only). **Addendum file deleted** (R4.2 scribe task complete). **Engine builds clean**, lint-touched-files clean, PAPER boot smoke complete (key-permission PASSED, boot pipeline 9/9, all paper-mode services active, PaperExchangeNullityProbe cycling, zero restarts post-fix). **9–10h soak monitor running,** hourly self-checks, zero unhandled exceptions.
**Deferred to M11b:** M11b gates on (a) PAPER soak passing per `docs/plans/M11a-local-soak.md` soak-exit criteria AND (b) TESTNET pre-M11b drill green (order-lifecycle + reconciliation + rate-limit under burst load); simulator-config-hash real source (sentinel today, R3.1); soak-evaluator wave (CRN tape, TOST calibration, sample-size pre-flight, lowFidelity rankings); `HaltSourceEnum.PAPER_DRAWDOWN` / `PAPER_RECONCILIATION_DRIFT` dedicated values (shared change deferred M11b); engine `IExchangeOrderSnapshot` → shared `IOrder` full migration (dual-shape today via D2 + D14 ports).
**Pre-M15 deferred items** (carried from prior milestone close logs, plus 1 new from post-R4 live-smoke):
- M15 Verify LIVE master-account `/sapi/v1/account/apiRestrictions` response shape includes every field the allowlist predicate checks — the M11a live-smoke fix loosened sub-account-only field defaults from true→false; if Binance master-account responses ever omit a field, the predicate would silently pass an unsafe key in LIVE mode. **Rationale:** sub-account and master-account response shapes diverge; live go-live must re-validate Binance docs vs real endpoint.
- M11 AuthFailureReasonEnum.BAD_SIGNATURE split (W1.5).
- M11 BaseRepository uuid-PK widening (cosmetic + scaling).
- M11 risk_state.updated_at true newer-wins (W2.4 pre-soak blocker, depends TESTNET validation).
- M11 LiveGateway AppConfigService injection + parser parity test (W2.5).
- M11 HKDF cursor sub-key derivation (W1.7).
- M11 revoked_jti TTL prune + age-floor (W1.6).
- M11 notePragmaticTransition clamps + try-block order + startOfRiskDayMs init + lastTransitionAuditId JSDoc (W2.6).
- M11 AUTH token TTL comment (W2.8).
- M11 Cache-Control halt/history endpoints (W2.7).
- M11 pino-pretty dev-arg fallback (W2.9, engine-side fallback when pretty transport missing at logger init).
- M11 strategy-comparison UI (walk-forward OOS, bootstrap CIs, per-regime tables, charting, deferred pending depth-aware + lowFidelity depth-aware extension).

**Next:** **M12 — Analysis MCP** (local-only). The cloud milestone (previously M11b) has been renumbered **M15 — Cloud go-live & scaling** and re-sequenced to the end, after M12/M13/M14. Local-first: cheap infra spend is deferred until soak + analysis + agent + CI gate are all proven on the local box.
