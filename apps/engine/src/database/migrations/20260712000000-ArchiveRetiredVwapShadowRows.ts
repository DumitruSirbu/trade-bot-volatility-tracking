import { MigrationInterface, QueryRunner } from 'typeorm';

// M53 D4. VWAP was fully retired 2026-07-01; xmom (id=20) is the sole active strategy. Seven
// stale `volatility-vwap` shadow rows (ids 1, 2, 4, 15, 16, 17, 19) were never archived, so
// `StrategyVersionRepository.findActiveShadows` (filters status='shadow', no name filter) still
// returns them and `ShadowStrategyOrchestratorService.onModuleInit` resolves and builds virtual
// ledgers for these dead cohorts on boot.
//
// The real benefit of archiving them is (a) a cleaner boot — onModuleInit no longer resolves or
// builds ledgers for retired VWAP cohorts — and (b) it keeps the incoming xmom TP-arm shadow
// cohorts (a future milestone) from mingling with dead VWAP rows under the same status='shadow'
// filter. The VWAP shadow evaluation path is already dormant at run time (it early-returns in
// StrategyService.onVolatilityDetected while xmom is the active strategy), so this migration is
// boot/hygiene cleanup, NOT a per-tick evaluation change.
//
// Bounded by an explicit id list (1, 2, 4, 15, 16, 17, 19) — the PRIMARY bound — combined with a
// name guard and a status guard. up() flips only these ids while status='shadow', and CANNOT touch
// id=3 (name='volatility-vwap', status='active') or id=20 (name='xmom'). Idempotent — a re-run is a
// no-op once the rows are archived. down() reverses over the SAME id list, which rules out any
// out-of-band row outside the seven (e.g. id=99). It does NOT guarantee against reviving one of the
// seven if that specific id was independently archived for an unrelated reason before rollback —
// an edge case with no current real-world path (all seven are status='shadow' today) and accepted
// as a known limitation rather than adding further state tracking.

const STRATEGY_NAME = 'volatility-vwap';
const RETIRED_SHADOW_IDS = [1, 2, 4, 15, 16, 17, 19];

export class ArchiveRetiredVwapShadowRows20260712000000 implements MigrationInterface {
    name = 'ArchiveRetiredVwapShadowRows20260712000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'archived', "archived_at" = now() WHERE "strategy_versions_id" = ANY($1) AND "name" = $2 AND "status" = 'shadow'`,
            [RETIRED_SHADOW_IDS, STRATEGY_NAME],
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'shadow', "archived_at" = NULL WHERE "strategy_versions_id" = ANY($1) AND "name" = $2 AND "status" = 'archived'`,
            [RETIRED_SHADOW_IDS, STRATEGY_NAME],
        );
    }
}
