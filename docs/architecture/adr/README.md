# ADR topic index

Read the ADR file for the topic. For **large ADRs**, use the anchored sub-entries below instead of loading the full file.

Also see [live-vs-backtest-contract.md](../live-vs-backtest-contract.md) for the live/backtest parity contract.

## Exchange and market data

| ADR | Title |
|-----|-------|
| [0001](0001-exchange-and-market-data.md) | Exchange integration & market-data boundary (M1) |

## Persistence and data model

| ADR | Title |
|-----|-------|
| [0002](0002-persistence-and-data-model.md) | Persistence & data model (M2) |
| [0002 § M27 amendment](0002-persistence-and-data-model.md#m27-amendment-2026-06-08-additive-capture-columns-see-adr-0043) | M27 additive capture columns (see ADR 0043) |

## Strategy

| ADR | Title |
|-----|-------|
| [0003](0003-strategy-engine.md) | Strategy engine (M3) |
| [0016](0016-strategy-version-lineage-and-promotion.md) | Strategy version lineage & promotion model (M8) |
| [0017](0017-walk-forward-and-same-event-comparison.md) | Walk-forward splits & same-event comparison (M8) |
| [0018](0018-statistical-significance-paired-block-bootstrap.md) | Statistical significance: paired block bootstrap (M8) |
| [0019](0019-promotion-gate.md) | Promotion gate (M8) |
| [0019 § M39 amendment](0019-promotion-gate.md#amendment--m39-2026-06-17) | M39 D3 realized-PnL precondition (W2), force_close abstain guard |

## Risk, halts, paper profile

| ADR | Title |
|-----|-------|
| [0004](0004-risk-management.md) | Risk management (M4) — depth, breadth, stress, sizing, slots |
| [0004 § 6a depth floor](0004-risk-management.md#6a-book-depth-per-coin-eligibility-guard-not-a-global-halt-m19) | Per-coin depth eligibility guard (M19) |
| [0004 § 6b breadth halt](0004-risk-management.md#6b-breadth-halt-risk-only-distance-const-decoupled-from-the-flow-routing-param-m19) | Breadth halt distance const (M19) |
| [0004 § 6c index shock](0004-risk-management.md#6c-index-shock-horizon-alignment-both-legs-on-the-5m-window-m21) | Index-shock 5m horizon (M21) |
| [0004 § 6d auto-resume](0004-risk-management.md#6d-breadth-stress-adaptive-auto-resume-m23) | Breadth-stress adaptive auto-resume (M23) |
| [0004 § 6e same-bar](0004-risk-management.md#6e-same-bar-stress-recalibration-auto-resume-wiring-m28) | Same-bar recalibration + auto-resume (M28) |
| [0004 § 8 sizing](0004-risk-management.md#8-sizing-math-seam-decimal-throughout-instrument-constrained-3-leverage) | Sizing math seam |
| [0042](0042-paper-exploration-profile.md) | Paper exploration profile (M25) |
| [0043](0043-m27-decision-data-capture-completeness.md) | Decision data-capture completeness (M27) |

## Execution and orders

| ADR | Title |
|-----|-------|
| [0005](0005-execution-order-policy.md) | Execution order policy (M5) |
| [0006](0006-idempotency-contract.md) | Idempotency contract (M5) |
| [0007](0007-partial-fill-semantics.md) | Partial-fill semantics (M5) |
| [0008](0008-sl-tp-attach.md) | SL/TP attach & protective-order fallback (M5) |
| [0011](0011-local-sltp-fallback-and-held-symbols.md) | Local SL/TP fallback & held-symbol subscription (M6) |
| [0045](0045-m38-fill-time-tp-rebase-and-fill-acceptance-guard.md) | M38 — Fill-time TP rebase + fill-acceptance guard (D1/D2) |
| [0030](0030-in-engine-rate-limit-token-bucket-policy.md) | In-engine rate-limit token-bucket policy (M11a) |

## Position, reconciliation, recovery

| ADR | Title |
|-----|-------|
| [0009](0009-position-state-machine.md) | Position state machine (M6) |
| [0010](0010-reconciliation-and-drift-policy.md) | Reconciliation & drift policy (M6) |
| [0012](0012-funding-and-pnl.md) | Funding cashflows + realized/unrealized PnL (M6) |
| [0013](0013-position-instrumentation.md) | Lifetime position instrumentation (M6) |
| [0014](0014-crash-recovery.md) | Crash recovery & re-association (M6) |

## Backtest, shadow, paper mode

| ADR | Title |
|-----|-------|
| [0015](0015-backtest-module.md) | BacktestModule (M7) |
| [0029](0029-shadow-counterfactual-and-fill-simulator-pipeline.md) | Shadow counterfactual + fill-simulator pipeline (M11a) |
| [0029 § M26 amendment](0029-shadow-counterfactual-and-fill-simulator-pipeline.md#m26-amendment-2026-06-08) | M26 shadow fill wiring |
| [0029 § M39 amendment](0029-shadow-counterfactual-and-fill-simulator-pipeline.md#amendment--m39-2026-06-17) | M39 shadow close path + next-bar exit walk |
| [0032](0032-paper-mode-architecture.md) | PAPER mode architecture |

## Observability, auth, control (M9)

| ADR | Title |
|-----|-------|
| [0020](0020-auth-and-cors.md) | Auth, CORS & token lifecycle |
| [0021](0021-kill-switch-contract.md) | Kill-switch contract |
| [0022](0022-read-api-surface.md) | Read API surface |
| [0023](0023-ws-sse-gateway.md) | WS/SSE gateway |
| [0024](0024-telegram-alerts.md) | Telegram alerts (outbound-only, M9) |
| [0044](0044-alert-schema.md) | Alert schema & Telegram position notifications (M32) |
| [0025](0025-startup-schema-validation-gate.md) | Startup schema-validation gate |
| [0031](0031-revoked-jti-prune-and-age-floor.md) | `revoked_jti` TTL prune + age-floor |

## Dashboard (M10)

| ADR | Title |
|-----|-------|
| [0026](0026-dashboard-architecture-and-topology.md) | Dashboard architecture & topology |
| [0027](0027-login-endpoint-bootstrap-secret.md) | Login endpoint with bootstrap secret |

## Go-live hardening

| ADR | Title |
|-----|-------|
| [0028](0028-key-permission-assertion-port.md) | Key-permission assertion port (M11a) |

## Phase 2 — MCP, agent, CI

| ADR | Title |
|-----|-------|
| [0033](0033-mcp-module-boundary-enforcement.md) | MCP module-boundary enforcement |
| [0034](0034-mcp-db-isolation-read-only-role.md) | MCP DB isolation: read-only role |
| [0035](0035-apps-agent-structural-boundary.md) | `apps/agent/` structural boundary |
| [0036](0036-agent-writer-role-and-draft-sdf.md) | `agent_writer` role + draft SDF |
| [0037](0037-llm-egress-allowlist.md) | LLM egress allowlist |
| [0038](0038-mcp-http-localhost-transport.md) | MCP HTTP localhost transport |
| [0039](0039-ci-gate-policy-and-branch-protection.md) | CI gate policy + branch protection |
| [0040](0040-supply-chain-sca-and-lockfile-integrity.md) | Supply-chain SCA + lockfile integrity |
| [0041](0041-dependency-pinning-and-provenance-for-exchange-deps.md) | Dependency pinning for exchange deps |
