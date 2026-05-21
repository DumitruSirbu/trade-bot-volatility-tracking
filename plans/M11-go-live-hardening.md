# M11 — Go-live hardening

**Goal:** Make the system safe and resilient enough to trade real funds at minimal
size.

**Depends on:** M1–M10.

## Tasks

- **WebSocket resilience.** Reconnect with backoff; detect stale streams; alert on stalls.
  - *Output:* simulated drops recover automatically with an alert.
- **Rate-limit guards.** Respect Binance limits; queue/throttle order calls.
  - *Output:* no rate-limit bans under burst conditions.
- **Secrets handling.** Live keys outside the repo; least-privilege API key (no withdrawals).
  - *Output:* keys sourced from secure env; verified withdrawal scope disabled.
- **Tight live caps.** Smallest viable position size; conservative daily/weekly loss limits for go-live.
  - *Output:* config profile for live with minimal risk.
- **Runbook.** Start/stop, halt, recover-from-crash, incident steps.
  - *Output:* `RUNBOOK.md`.
- **Switch ccxt to live keys** and start trading at minimal size.
  - *Output:* first real trade with all safety rails active.

## Deployment topology

Everything is containerized; the whole stack runs on a single cloud (AWS or GCP).
The hard constraint: the **engine must run as an always-on container** — never a
scale-to-zero / request-driven service, because it holds a persistent Binance
WebSocket and in-memory state.

```
┌─ Single cloud (AWS or GCP), one VPC ───────────────────────────────┐
│                                                                     │
│   Dashboard container (nginx, static)  ──HTTPS/WSS (authed)──┐      │
│                                                              ▼      │
│   Engine container (NestJS, ALWAYS-ON)  ◀──── internal API/WS ──    │
│     - persistent Binance WS · strategy · risk · execution          │
│     - read API + WS gateway (authenticated)                        │
│                         │                                          │
│                         ▼                                          │
│   Managed Postgres (RDS / Cloud SQL) — automated backups + PITR    │
└─────────────────────────────────────────────────────────────────────┘
```

| Component | AWS | GCP | Constraint |
|-----------|-----|-----|------------|
| **Engine** | ECS **Fargate service** (desired ≥1) or EC2 + compose | **GCE VM** + compose, or Cloud Run with **min-instances=1 + CPU always allocated** | Always-on; no scale-to-zero |
| **Dashboard** | Fargate / S3+CloudFront | Cloud Run / GCS+CDN | May scale to zero (static) |
| **Postgres** | **RDS** | **Cloud SQL** | Managed for live (backups/PITR) |

- **Tasks:** author the deploy target (Fargate task defs / GCE compose / Cloud Run service), wire secrets via the cloud secret manager (never baked into images), provision managed Postgres, and confirm the engine container stays up across redeploys.
  - *Output:* the stack runs on the chosen cloud with the engine always-on and Postgres managed.

## Definition of done

The bot trades real funds at minimal size with reconnect/rate-limit/secret
safeguards, a documented runbook, and the containerized stack deployed to a single
cloud with an always-on engine and managed Postgres.
