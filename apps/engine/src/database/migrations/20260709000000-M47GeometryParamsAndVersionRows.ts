import { MigrationInterface, QueryRunner } from 'typeorm';

// M47 (R:R geometry fix) — DB param migration. Runs FIRST, before the engine deploys
// (non-rolling: stop engine → run migration → start new engine). Two jobs:
//
//   1. JSON-MERGE BACKFILL — add the four new M47 geometry params to EVERY existing
//      strategy_versions row so they continue to load under the .strict() params schema
//      the new engine ships. This is a `params || '{...}'::jsonb` merge: existing keys
//      (including any production-tuned values) are preserved; only the four new keys are
//      added (or overwritten to defaults if somehow already present). This is NOT a seeder
//      re-run — the seeder uses ON CONFLICT DO UPDATE SET params = EXCLUDED.params (a full
//      blob overwrite) and must NEVER run against live post-M47 (it would clobber tuned
//      params). We use raw SQL JSON math, never the seeder class.
//
//   2. NEW GEOMETRY-COUPLED VERSION ROWS (v1.1 / v2.1 / v3.1) — clone the live v1/v2/v3 rows
//      (same name, same direction, same params) into new rows carrying the M47 defaults, so
//      pre-M47 inverted-geometry trades (old version IDs) are cleanly partitioned from
//      post-M47 coupled-geometry trades (new version IDs) by strategy_versions_id (BLOCKER 4).
//      The `version` column is an INTEGER with a UNIQUE(name, version) constraint — there is
//      no string 'v1.1' form. We encode the point-release as integer 11/21/31 (v1.1→11,
//      v2.1→21, v3.1→31), preserving ordering and uniqueness. parent_version_id points each
//      new row at the row it was cloned from (lineage).
//
// ── ACTIVATION (read carefully — DB status is NOT the runtime trade selector) ──
// Runtime active-strategy selection is by PRIMARY KEY via the ACTIVE_STRATEGY_VERSION_ID env
// var, resolved in StrategyService.onModuleInit (findById, NOT by status). The `status`
// column drives (a) the dashboards/promotion-audit and the partial unique index
// uq_strategy_versions_active_per_name (one row with status='active' per name), and (b) the
// shadow orchestrator (findActiveShadows → status='shadow'). This migration sets `status` so
// the DB-level "active" label tracks the new geometry-coupled rows, BUT it deliberately does
// NOT — and cannot safely — switch live trading onto them on its own:
//
//   * The live trade path is selected by the ACTIVE_STRATEGY_VERSION_ID env var. Moving the
//     bot onto a new row requires an OPERATOR env change + engine restart (document in the
//     M47 deploy runbook), not just a status flip.
//   * StrategyRegistry maps `${name}:${version}` to a hardcoded IStrategy impl keyed on the
//     strategy class's integer `version` (0/1/2/3 only). It has NO implementation registered
//     for versions 11/21/31. Until the registry/strategy classes are extended to register
//     the bumped versions, resolving a new row through the ACTIVE path would throw
//     StrategyConfigException at boot, and the shadow path would skip-and-warn. The new rows
//     therefore persist correctly and partition the data, but the engine CANNOT trade them
//     yet. Wiring the registry for v1.1/v2.1/v3.1 is a prerequisite for the Task 2/3/4
//     coupling work to take effect on live trades and is surfaced to the orchestrator.
//
// Because of that, this migration does NOT flip status='active' onto a new row by default
// (doing so would point the promotion-audit label at a row the engine cannot resolve and
// would collide with the partial unique index against the current active row). It inserts the
// new rows as status='shadow' so they are visible and partition the data without destabilizing
// the running active selection. The operator promotes the chosen new row (status + env var)
// during the M47 deploy AFTER the registry is wired.

const STRATEGY_NAME = 'volatility-vwap';

// Source rows to clone (the live geometry-bearing versions). v0 (baseline, trade_enabled:false)
// is intentionally not cloned — it carries no geometry to couple.
const VERSION_CLONES: { sourceVersion: number; newVersion: number }[] = [
    { sourceVersion: 1, newVersion: 11 }, // v1 → v1.1 (mean-reversion)
    { sourceVersion: 2, newVersion: 21 }, // v2 → v2.1 (momentum)
    { sourceVersion: 3, newVersion: 31 }, // v3 → v3.1 (hybrid)
];

const NEW_VERSIONS = VERSION_CLONES.map((clone) => clone.newVersion);

// The exact four keys added by M47 (Task 1). Kept as a literal so the up() merge and the
// down() removal reference the same set.
const M47_PARAMS_JSON = '{"min_rr": 1.5, "entry_pct_floor": 0.3, "atr_floor_multiplier": 0.3, "max_tp_dist_factor": 5.0}';

export class M47GeometryParamsAndVersionRows20260709000000 implements MigrationInterface {
    name = 'M47GeometryParamsAndVersionRows20260709000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // 1. JSON-merge backfill onto every existing row (preserves all other keys).
        await queryRunner.query(
            `UPDATE "strategy_versions"
             SET "params" = "params" || '${M47_PARAMS_JSON}'::jsonb
             WHERE "params" IS NOT NULL`,
        );

        // 2. Insert the geometry-coupled clones. Each new row copies the source row's name,
        //    direction, and params (which now already carry the M47 keys from step 1), then
        //    re-merges the M47 defaults to remove any ambiguity, and points parent_version_id
        //    at the source row for lineage. Inserted as status='shadow' (see header note on
        //    activation). ON CONFLICT DO NOTHING keeps the migration idempotent on re-run.
        for (const clone of VERSION_CLONES) {
            await queryRunner.query(
                `INSERT INTO "strategy_versions" ("name", "version", "direction", "params", "status", "parent_version_id")
                 SELECT
                     "name",
                     $2,
                     "direction",
                     "params" || '${M47_PARAMS_JSON}'::jsonb,
                     'shadow',
                     "strategy_versions_id"
                 FROM "strategy_versions"
                 WHERE "name" = $1 AND "version" = $3
                 ON CONFLICT ("name", "version") DO NOTHING`,
                [STRATEGY_NAME, clone.newVersion, clone.sourceVersion],
            );
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // 1. Delete the new geometry-coupled rows. Remove dependent FK rows first
        //    (decisions/positions FK strategy_versions with ON DELETE RESTRICT; agent_run_history
        //    parent_version_id likewise). Mirrors SeedStrategyVersions.down() cleanup order.
        await queryRunner.query(
            `DELETE FROM "decisions" WHERE "strategy_version_id" IN (
                SELECT "strategy_versions_id" FROM "strategy_versions"
                WHERE "name" = $1 AND "version" = ANY($2)
             )`,
            [STRATEGY_NAME, NEW_VERSIONS],
        );
        await queryRunner.query(
            `DELETE FROM "positions" WHERE "strategy_version_id" IN (
                SELECT "strategy_versions_id" FROM "strategy_versions"
                WHERE "name" = $1 AND "version" = ANY($2)
             )`,
            [STRATEGY_NAME, NEW_VERSIONS],
        );

        const agentHistoryRows = (await queryRunner.query(
            `SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agent_run_history') AS exists`,
        )) as { exists: boolean }[];

        if (agentHistoryRows[0]!.exists) {
            await queryRunner.query(
                `DELETE FROM "agent_run_history" WHERE "parent_version_id" IN (
                    SELECT "strategy_versions_id" FROM "strategy_versions"
                    WHERE "name" = $1 AND "version" = ANY($2)
                 )`,
                [STRATEGY_NAME, NEW_VERSIONS],
            );
        }

        await queryRunner.query(`DELETE FROM "strategy_versions" WHERE "name" = $1 AND "version" = ANY($2)`, [STRATEGY_NAME, NEW_VERSIONS]);

        // 2. JSON-remove the four M47 keys from the remaining (pre-M47) rows so a revert to the
        //    old .strict() schema is safe.
        await queryRunner.query(
            `UPDATE "strategy_versions"
             SET "params" = "params" - 'min_rr' - 'entry_pct_floor' - 'atr_floor_multiplier' - 'max_tp_dist_factor'
             WHERE "params" IS NOT NULL`,
        );
    }
}
