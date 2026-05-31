import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a corrective follow-up. On a fresh install TypeORM applies migrations in
// timestamp order, which means `CorrectActiveStrategyStatus20260531000000`
// (May 31) runs BEFORE `PromoteShadowStrategyVersions20260621000000` (Jun 21).
//
// The May 31 migration was written to fix a soak-DB state where v1 (id=2)
// was already 'shadow' — it expected:
//   id=1: 'active' → 'shadow'
//   id=2: 'shadow' → 'active'
// On the soak DB that was correct because PromoteShadowStrategyVersions had
// already promoted all draft rows (including id=2) to shadow before this
// migration was applied manually.
//
// On a fresh install the order is reversed: when CorrectActiveStrategyStatus
// runs, id=2 is still 'draft' (not 'shadow'), so the UPDATE is a no-op.
// Then PromoteShadowStrategyVersions converts every 'draft' → 'shadow',
// leaving no row with status='active' at all.
//
// This migration re-establishes the invariant: exactly one row
// (strategy_versions_id=2, ACTIVE_STRATEGY_VERSION_ID=2 in .env) carries
// status='active'. It is idempotent on the soak DB (where id=2 is already
// 'active') and corrective on fresh installs (where id=2 would otherwise be
// left as 'shadow').
//
// down() restores the pre-state by moving id=2 back to 'shadow', matching
// the state left by PromoteShadowStrategyVersions.
export class EnsureActiveStrategyVersion20260622000000 implements MigrationInterface {
    name = 'EnsureActiveStrategyVersion20260622000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // Ensure id=1 (v0, baseline) is shadow — safe no-op if already shadow.
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = 1 AND "status" <> 'shadow'`);
        // Ensure id=2 (v1, configured live strategy) is active — safe no-op if
        // already active; corrective when status='shadow' from fresh-install path.
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'active' WHERE "strategy_versions_id" = 2 AND "status" <> 'active'`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Restore to the state left by PromoteShadowStrategyVersions: all rows
        // shadow (no active). The CorrectActiveStrategyStatus.down() that follows
        // (in revert order) will then restore id=1 to active.
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = 2 AND "status" = 'active'`);
    }
}
