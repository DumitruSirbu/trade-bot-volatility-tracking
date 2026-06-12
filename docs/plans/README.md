# Milestone index

Status vocabulary: `ACTIVE` | `DONE` | `DEFERRED` | `INDEX`.

Exactly **one** row may be `ACTIVE`. Status lives here only — not in plan frontmatter.

| ID | Status | Summary (1 line) | ADRs | Modules |
|----|--------|------------------|------|---------|
| M33 | DONE | Live exit enforcement (time-stop + paper protective simulation + entry cashflow) | 0008, 0011, 0012, 0015 | execution, position, risk |
| M32 | DONE | Dashboard closed-positions history + Telegram position notifications | 0044, 0024, 0022 | dashboard, alert |
| M31 | DONE | Zombie positions & broken position-lifecycle | 0009, 0012, 0014 | position, risk |
| M30 | DONE | Idiosyncratic-edge soak gate + idiosyncrasy observability | — | analysis, risk |
| M29 | DONE | Paper funnel diagnosis + first-fill enablement | 0004, 0042 | risk, strategy |
| M28 | DONE | Same-bar stress threshold recalibration + auto-resume wiring | 0004 | risk |
| M27 | DONE | Decision data-capture completeness | 0043 | strategy, risk |
| M26 | DONE | Shadow counterfactual fill wiring | 0029 | shadow, backtest |
| M25 | DONE | Paper exploration enablement | 0042 | risk, strategy |
| M24 | DONE | Live/paper open-fill wiring | 0005, 0007 | execution |
| M23 | DONE | Market-stress adaptive auto-resume | 0004 | risk |
| M22 | DONE | Depth-floor recalibration | 0004 | risk |
| M21 | DONE | Index-shock horizon alignment (BTC/ETH 5m leg) | 0004 | risk |
| M19 | DONE | Per-coin liquidity gate | 0004 | risk |
| M18 | DONE | Directional rate-limit drift alert | 0030 | alert, exchange |
| M17 | DONE | Automated daily DB backup | — | backup |
| M16 | DONE | Test-DB isolation | — | devops |
| M14 | DONE | CI review gate (deterministic CI gates) | 0039, 0040, 0041 | ci |
| M13 | DONE | Agentic weekly loop (phase 2) | 0033–0038 | agent |
| M12 | DONE | Analysis MCP (phase 2) | 0033, 0034 | mcp, analysis |
| M11a | DONE | Local soak hardening | 0028, 0029, 0030, 0032 | soak, paper |
| M10 | DONE | Dashboard (React, containerized) | 0026, 0027 | dashboard |
| M9 | DONE | Observability, control & read API | 0020–0025 | auth, alert, api |
| M8 | DONE | Strategy versioning & comparison | 0016–0019 | strategy, backtest |
| M7 | DONE | Backtesting engine | 0015 | backtest |
| M6 | DONE | Position management & reconciliation | 0009–0014 | position, execution |
| M5.5 | DONE | Adversarial backfill (pre-M6 hardening) | — | backtest |
| M5 | DONE | Execution (testnet) | 0005–0008 | execution |
| M4 | DONE | Risk management | 0004 | risk |
| M3 | DONE | Strategy engine | 0003 | strategy |
| M2 | DONE | Persistence & data model | 0002 | persistence |
| M1 | DONE | Exchange integration & market data | 0001 | exchange |
| M0 | DONE | Foundation & scaffolding | — | foundation |
| M11 | DEFERRED | Go-live hardening (split parent) | — | go-live |
| M15 | DEFERRED | Cloud go-live & scaling | — | go-live |
| M20 | DEFERRED | Pre-cloud go-live blocker hardening | — | go-live |
| 00-overview | INDEX | Timeless design + locked decisions | — | — |
| M9-execution-plan | DONE | M9 dispatch checklist | 0020–0025 | — |
| M10-execution-plan | DONE | M10 dispatch checklist | 0026, 0027 | — |
| M12-execution-plan | DONE | M12 dispatch checklist | 0033, 0034 | — |
| M13-execution-plan | DONE | M13 dispatch checklist | 0033–0038 | — |
| M14-execution-plan | DONE | M14 dispatch checklist | 0039–0041 | — |

Done milestone specs live in [`archive/`](archive/). Active and deferred specs stay in this directory.
