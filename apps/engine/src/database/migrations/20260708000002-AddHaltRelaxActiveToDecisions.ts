import { MigrationInterface, QueryRunner } from 'typeorm';

// M36 Dispatch C — bias marker. Forced-continuation outcomes produced while the
// consecutive-loss halt is relaxed (paper soak `paperRelaxConsecutiveLossHalt`)
// are a conditional sample from the left tail of the regime distribution and
// must be fenced from cross-version A/B analysis. This adds a boolean
// `halt_relax_active` column to BOTH `decisions` and `shadow_decisions`, stamped
// at write time from the resolved boot flag.
//
// NOT NULL DEFAULT false: every legacy row predates halt relaxation, so false is
// the correct historical value and the default backfills them in place. No gate
// behaviour change. Reversible (reverse order in down()).

export class AddHaltRelaxActiveToDecisions20260708000002 implements MigrationInterface {
    name = 'AddHaltRelaxActiveToDecisions20260708000002';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "halt_relax_active" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "shadow_decisions" ADD COLUMN "halt_relax_active" boolean NOT NULL DEFAULT false`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "shadow_decisions" DROP COLUMN IF EXISTS "halt_relax_active"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "halt_relax_active"`);
    }
}
