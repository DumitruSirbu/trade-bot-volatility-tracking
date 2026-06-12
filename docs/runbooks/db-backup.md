# Daily DB backup — operator runbook

Operator reference for the automated daily DB backup (M17). The full design lives
in `docs/plans/archive/M17-daily-db-backup.md`. This runbook covers the **DevOps setup**
the operator must do before the first scheduled run; the in-engine scheduler
behaviour (Wave 2) is documented inline in that code and summarised here.

> This automates — it does **not** replace — the CLAUDE.md rule-9 manual
> `pg_dump`. The two coexist: automated dumps are `trade_bot_<UTC>.sql.gz`,
> manual dumps are `backup_*`. Retention (below) prunes **only** the automated
> `trade_bot_*` files; your manual `backup_*` dumps are never counted or deleted.

---

## 1. What it does

- An in-engine NestJS scheduler dumps the **soak** DB (`DATABASE_URL`) once per
  UTC day at `DB_BACKUP_CRON` (default `0 3 * * *` → 03:00 UTC), via the
  `pg_dump` client bundled in the engine image (`postgresql18-client`, matching
  the `postgres:18.4-alpine` server major 18).
- Each dump is gzipped and written to `DB_BACKUP_DIR`. The scheduler then keeps
  the `DB_BACKUP_RETENTION` (default 3) newest `trade_bot_*` dumps and prunes
  the rest.
- `pg_dump` is **read-only** — it never mutates, drops, or reverts. The
  `postgres` service and `postgres-data` volume are never touched.
- Local-disk only. Cloud/offsite (S3) upload is out of scope for M17.

---

## 2. Host-vs-container `DB_BACKUP_DIR` (the path contract)

`DB_BACKUP_DIR` is the directory the **engine** writes to, and its value differs
by run context:

| Run context                | `DB_BACKUP_DIR` the engine uses | Set by |
| -------------------------- | ------------------------------- | ------ |
| compose engine container   | `/var/backups/trade-bot`        | explicit `engine.environment` override in `docker-compose.yml` |
| host dev (`pnpm engine:dev`) | `./backups`                   | `.env` (default) |
| cloud                      | S3-class object store           | out of scope (M17) |

In compose, the container path `/var/backups/trade-bot` is **bind-mounted** to
the host path `DB_BACKUP_DIR` from `.env` (default `./backups`):

```yaml
volumes:
    - ${DB_BACKUP_DIR:-./backups}:/var/backups/trade-bot
```

Because the engine writes to the bind mount, dumps appear on the **host** and
survive `docker compose up -d --force-recreate engine`. A container-local
`./backups` would be lost on recreate — which is why the override exists.

---

## 3. Non-root mount permissions (required before first run)

The runtime container runs as `USER node` (uid **1000**). A freshly created host
`./backups` is usually root-owned, so the engine cannot write to it until you
make it writable by uid 1000:

```bash
mkdir -p ./backups
chown 1000:1000 ./backups
```

Verify uid 1000 can create / rename / unlink under the mount (the exact ops the
scheduler performs — atomic `<name>.tmp` → rename, then retention unlink):

```bash
docker compose exec engine sh -c '
  set -e
  d=/var/backups/trade-bot
  : > "$d/trade_bot_19700101_0000.sql.gz.tmp"
  mv "$d/trade_bot_19700101_0000.sql.gz.tmp" "$d/trade_bot_19700101_0000.sql.gz"
  rm "$d/trade_bot_19700101_0000.sql.gz"
  echo "mount OK as uid $(id -u)"
'
```

If this prints `Permission denied`, re-check the host `chown 1000:1000`.

> The engine image also runs this create/rename/unlink check at **build time**
> against an image-local dir (see `apps/engine/Dockerfile` M17 note), proving the
> image layer. The host-mount `chown` is the operator's remaining responsibility.

---

## 4. Enabling / disabling

- **Compose soak:** `DB_BACKUP_ENABLED=true` (default). The engine image carries
  `pg_dump`, so the scheduler runs.
- **Host dev (`pnpm engine:dev`):** set `DB_BACKUP_ENABLED=false`. M17 does not
  provision a host `pg_dump` client; rely on the rule-9 manual dump.
- **Test / CI:** `DB_BACKUP_ENABLED=false` (set in `.env.test.example` and the
  `test` job env in `.github/workflows/ci.yml`) so the ephemeral 6900 test DB is
  never dumped.

---

## 5. Verify a backup landed

```bash
# After 03:00 UTC (or with a near-future DB_BACKUP_CRON for a smoke):
ls -lh ./backups/trade_bot_*.sql.gz

# Restore smoke into a throwaway DB (NEVER the soak DB):
gunzip -c ./backups/trade_bot_<UTC>.sql.gz | psql postgresql://user:pass@host:port/throwaway_db
```

---

## 6. Verify the engine image carries a v18 client

```bash
docker compose build engine
docker compose run --rm --no-deps engine pg_dump --version   # -> pg_dump (PostgreSQL) 18.x
```

The build itself fails if `pg_dump` is not major 18 (build-time smoke in the
Dockerfile), so a base-image drift to a non-18 client is caught at build, not at
the first 03:00 tick.
