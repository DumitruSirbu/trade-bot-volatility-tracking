# M11b — Cloud go-live & scaling

**Goal:** Move the same stack off the local box onto a cheap, single-cloud
deployment for real-money trading at minimal size, **only after the M11a soak
confirms a live edge worth paying for**.

**Depends on:** M11a (local soak complete; soak exit criteria met).
**Defers from M11b until explicitly justified:** multi-instance scaling, managed
Kubernetes, multi-region, blue/green deploys.

## Why this is gated

At $500–$1,000 of capital, infra cost is a real risk factor. The target is
**break-even on infra at minimum**: a single-VPS, single-compose deployment
sized to the bot, not a hyperscaler default. Hyperscaler managed services are
considered only where they pay for themselves (managed Postgres + PITR is the
likely first candidate; secret managers are usually not).

## Hosting menu (pick one before starting)

The decision is deferred to the start of M11b because the right choice depends on
what the soak proved and what live capital is actually committed.

| Profile | What it is | Approx cost/mo | When it's the right pick |
|---------|------------|----------------|--------------------------|
| **A. Cheap VPS** | Hetzner / Contabo / DigitalOcean single VM, `docker compose up -d`, Caddy, self-managed Postgres + nightly `pg_dump` + offsite | $5–15 | Live capital ≤ $2k and the soak proved the bot survives crashes cleanly |
| **B. Hyperscaler, all-in-one VM** | AWS EC2 / GCP GCE single VM + compose; cloud secret manager; managed Postgres optional | $30–60 | User wants AWS/GCP for org reasons or expects to scale to B-tier within months |
| **C. Hyperscaler, managed services** | ECS Fargate / Cloud Run (min=1, always-on) for engine; managed Postgres; cloud secret manager; ALB / managed TLS | $60–120 | Capital + edge justifies it; multiple strategies / accounts on the way |

The hard constraint applies to all three: the **engine must run as an always-on
container** — never scale-to-zero / request-driven, because it holds a persistent
Binance WebSocket and in-memory state.

## Tasks

### Common (any hosting profile)

- **Switch ccxt to live keys** with the M11a startup key-permission assertion
  still mandatory.
  - *Output:* first real trade with all safety rails active.
- **Network posture.** Engine API is **private** (bound to the docker network /
  VPC, never internet-facing); TLS terminates at the dashboard ingress only;
  Postgres has no public IP.
  - *Output:* the engine API and DB are unreachable from the public internet,
    verified by an external port scan.
- **External reverse proxy.** Caddy (auto-TLS) or nginx + Let's Encrypt in front
  of the dashboard. The engine's existing internal nginx (M10) stays as the
  intra-stack proxy.
  - *Output:* dashboard served over HTTPS with a valid cert; engine never
    exposed.
- **Static egress IP for Binance allow-list.** Cloud profile gives this for free
  (NAT Gateway / VM static IP). For Profile A, allow-list the VPS IP directly.
  - *Output:* Binance key IP allow-list is non-empty and matches the deployment.
- **Secrets manager (if Profile B/C).** Live keys, JWT secret, Telegram token
  pulled from AWS Secrets Manager / GCP Secret Manager / `sops` + `age`
  (self-hosted, file-based, free) at boot. Never baked into images, never in
  env files committed to the repo.
  - *Output:* an image rebuild does not require touching secrets; secret
    rotation is a single-step procedure documented in the runbook.
- **Backups (if not Profile C managed).** Nightly `pg_dump` to an object store
  (S3 / GCS / Backblaze B2) with documented restore; for Profile C, rely on
  managed PITR but **still** restore-test quarterly.
  - *Output:* a documented restore from the offsite copy executes successfully.
- **Multi-instance safety.** Even if only one instance runs, the engine must
  refuse to start a second writer against the same Postgres (advisory lock or
  similar). The M11a "true newer-wins on risk_state.updated_at" item is the
  pre-condition; this task adds the explicit guard.
  - *Output:* booting a second engine container against the same DB exits
    cleanly with a clear log line; no double-writer race possible.

### Deployment topology (target diagram)

Single cloud, one VPC. Adjust components per hosting profile.

```
┌─ Single cloud (chosen at M11b start), one VPC ────────────────────┐
│                                                                    │
│   Dashboard container (nginx, static)  ──HTTPS/WSS (authed)──┐     │
│         ▲                                                    ▼     │
│   Caddy / nginx (TLS terminator)                                   │
│         ▲                                                          │
│         └── public internet (only ingress)                         │
│                                                                    │
│   Engine container (NestJS, ALWAYS-ON)  ◀── internal API/WS ──     │
│     - persistent Binance WS · strategy · risk · execution         │
│     - read API + WS gateway (authenticated)                       │
│                         │                                         │
│                         ▼                                         │
│   Postgres (managed if Profile C, self-managed for A/B)           │
└────────────────────────────────────────────────────────────────────┘
```

| Component | Profile A (cheap VPS) | Profile B (hyperscaler VM) | Profile C (managed) | Constraint |
|-----------|----------------------|----------------------------|---------------------|------------|
| **Engine** | VPS + `docker compose` (`restart: unless-stopped`) + systemd watchdog | EC2 / GCE + compose | ECS Fargate / Cloud Run **min-instances=1 + CPU always allocated** | Always-on; no scale-to-zero |
| **Dashboard** | Same VPS, compose | Same VM, compose, or S3+CloudFront | Fargate / Cloud Run / static CDN | May scale to zero (static) |
| **Postgres** | Compose Postgres on VPS | Self-managed on VM, or managed | RDS / Cloud SQL | Encrypted at rest + in transit; PITR for C |
| **Secrets** | `sops` + `age` or `chmod 600` `.env` | Cloud secret manager | Cloud secret manager | Never in images |
| **TLS** | Caddy | Caddy or ALB | ALB / managed cert | Public ingress only at dashboard |

### Deferred (do not enter without an explicit follow-up milestone)

These were in the original M11 scope and are explicitly **out** of M11b unless a
concrete need emerges. Each would justify its own milestone, not silent scope
growth.

- Multi-instance horizontal scaling of the engine. The single-writer constraint
  means horizontal scaling needs leader election + state-handoff design first.
- Managed Kubernetes (EKS / GKE). Cost and operational burden are not justified
  by a single always-on container.
- Multi-region failover. Binance is a single counterparty; geo-redundancy at
  this scale is theatre.
- Blue/green deploys. The crash-recovery pipeline already handles cold restarts;
  blue/green adds complexity without a corresponding live-trading benefit at
  one-instance scale.
- Pre-M11 deferred items not pulled into M11a (BaseRepository uuid-PK widening,
  strategy-comparison UI). Re-scope as their own work items if they become
  load-bearing.

### Scaling gate (post-go-live relaxation)

Relax the restricted profile (1 position → 3, risk 0.10–0.25% → higher, tier-1
→ broader universe) only after ≥30–60 days **live** (not demo) where: realized
slippage matches the model; live expectancy is positive; stop behavior matches
backtest; no hidden operational failures; and the chosen version still beats
the others on net risk-adjusted metrics (M8 promotion gate against live data).
Until then, the restricted profile holds.

- *Output:* a documented checklist that must pass before any cap is relaxed;
  relaxation is a deliberate, evidence-gated step, separate from the M11b
  go-live event itself.

## Definition of done

The bot trades real funds at minimal size on the chosen hosting profile, with
the engine always-on, the engine API and DB private, TLS terminated at a single
public ingress, secrets sourced from a secret manager (or `chmod 600` `.env` for
Profile A), backups + restore-tested, a documented runbook covering incidents
and key rotation, and the M11a restricted v1 profile still in force pending the
scaling gate.
