# M11 — Go-live hardening

**Goal:** Make the system safe and resilient enough to trade real funds at minimal
size.

**Depends on:** M1–M10.

## Tasks

- **WebSocket resilience.** Reconnect with backoff; detect stale streams; alert on stalls.
  - *Output:* simulated drops recover automatically with an alert.
- **Rate-limit guards.** Respect Binance limits; queue/throttle order calls.
  - *Output:* no rate-limit bans under burst conditions.
- **Secrets handling.** Live keys from the cloud secret manager, outside the repo; least-privilege API key (no withdrawals).
  - *Output:* keys sourced from the secret manager; no secret in any committed file.
- **Startup key-permission assertion.** On boot, query the exchange key's permissions/IP-restriction via ccxt and **abort startup if withdrawal scope is enabled or the IP allow-list is empty.** Makes the no-withdrawal invariant verifiable, not just asserted.
  - *Output:* a key with withdrawal rights (or no IP allow-list) prevents the engine from starting.
- **Network posture.** The engine API is **private** (VPC-only / security-group restricted to the dashboard origin), not internet-facing; TLS terminated; managed Postgres on a private subnet with no public IP, encrypted at rest and in transit.
  - *Output:* the engine API and DB are unreachable from the public internet.
- **Tight live caps.** Smallest viable position size; conservative daily/weekly loss limits for go-live.
  - *Output:* config profile for live with minimal risk.
- **Runbook.** Start/stop, halt, recover-from-crash, incident steps, and a **key-compromise / token-rotation procedure** (suspected leaked exchange key or API token).
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
