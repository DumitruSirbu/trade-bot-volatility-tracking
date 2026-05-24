/**
 * Migration AddStrategyPromotionAuditAndComparisonReports — unit test (M8 W2).
 *
 * Coverage:
 *   - up() adds the four promotion-audit columns to strategy_versions (nullable).
 *   - up() creates the partial unique index uq_strategy_versions_active_per_name
 *     scoped WHERE status = 'active'.
 *   - up() creates the comparison_reports table with the documented columns + index.
 *   - up() attaches the FK fk_strategy_versions_promotion_report AFTER the table is
 *     created (forward-reference order).
 *   - down() drops the FK BEFORE the table is dropped, then the index, then columns
 *     in reverse add order.
 *   - up() + down() are reversible — every structural addition has a matching removal.
 */

import { QueryRunner } from 'typeorm';

import { AddStrategyPromotionAuditAndComparisonReports20260527000000 } from '../../src/database/migrations/20260527000000-AddStrategyPromotionAuditAndComparisonReports';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

describe('Migration AddStrategyPromotionAuditAndComparisonReports — up()', () => {
    it('adds the four promotion-audit columns to strategy_versions as nullable', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        const addedColumns = ['promoted_at', 'archived_at', 'promotion_report_id', 'promotion_note'];

        for (const column of addedColumns) {
            const stmt = sqls.find((sql) => sql.includes('"strategy_versions"') && sql.includes(`"${column}"`) && sql.includes('ADD COLUMN'));

            expect(stmt).toBeDefined();
            expect(stmt).not.toMatch(/NOT NULL/);
        }
    });

    it('creates the partial unique index keyed on name WHERE status = active', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(qr);

        const stmt = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .find((sql) => sql.includes('CREATE UNIQUE INDEX') && sql.includes('uq_strategy_versions_active_per_name'));

        expect(stmt).toBeDefined();
        expect(stmt).toMatch(/WHERE "status" = 'active'/);
    });

    it('creates the comparison_reports table with run_label, jsonb fields, integer[] version_ids, and created_at default', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(qr);

        const create = querySpy.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('CREATE TABLE "comparison_reports"'));

        expect(create).toBeDefined();
        expect(create).toMatch(/"run_label" text NOT NULL/);
        expect(create).toMatch(/"from_ms" bigint NOT NULL/);
        expect(create).toMatch(/"to_ms" bigint NOT NULL/);
        expect(create).toMatch(/"split_policy" jsonb NOT NULL/);
        expect(create).toMatch(/"folds" jsonb NOT NULL/);
        expect(create).toMatch(/"version_ids" integer\[\] NOT NULL/);
        expect(create).toMatch(/"summary" jsonb NOT NULL/);
        expect(create).toMatch(/"artefact_uri" text NOT NULL/);
        expect(create).toMatch(/"created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    });

    it('attaches the FK strategy_versions.promotion_report_id → comparison_reports AFTER the table is created', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        const tableIdx = sqls.findIndex((sql) => sql.includes('CREATE TABLE "comparison_reports"'));
        const fkIdx = sqls.findIndex((sql) => sql.includes('fk_strategy_versions_promotion_report'));

        expect(tableIdx).toBeGreaterThanOrEqual(0);
        expect(fkIdx).toBeGreaterThan(tableIdx);
        expect(sqls[fkIdx]).toMatch(/ON DELETE SET NULL/);
    });
});

describe('Migration AddStrategyPromotionAuditAndComparisonReports — down()', () => {
    it('drops the FK before dropping the comparison_reports table', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.down(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        const fkIdx = sqls.findIndex((sql) => sql.includes('DROP CONSTRAINT') && sql.includes('fk_strategy_versions_promotion_report'));
        const tableIdx = sqls.findIndex((sql) => sql.includes('DROP TABLE') && sql.includes('comparison_reports'));

        expect(fkIdx).toBeGreaterThanOrEqual(0);
        expect(tableIdx).toBeGreaterThan(fkIdx);
    });

    it('drops the partial unique index and all four audit columns in reverse add order', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.down(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        const indexIdx = sqls.findIndex((sql) => sql.includes('DROP INDEX') && sql.includes('uq_strategy_versions_active_per_name'));
        const noteIdx = sqls.findIndex((sql) => sql.includes('DROP COLUMN') && sql.includes('"promotion_note"'));
        const reportIdx = sqls.findIndex((sql) => sql.includes('DROP COLUMN') && sql.includes('"promotion_report_id"'));
        const archivedIdx = sqls.findIndex((sql) => sql.includes('DROP COLUMN') && sql.includes('"archived_at"'));
        const promotedIdx = sqls.findIndex((sql) => sql.includes('DROP COLUMN') && sql.includes('"promoted_at"'));

        expect(indexIdx).toBeGreaterThanOrEqual(0);
        // Add order was: promoted_at, archived_at, promotion_report_id, promotion_note.
        // Reverse must be: promotion_note → promotion_report_id → archived_at → promoted_at.
        expect(reportIdx).toBeGreaterThan(noteIdx);
        expect(archivedIdx).toBeGreaterThan(reportIdx);
        expect(promotedIdx).toBeGreaterThan(archivedIdx);
    });
});

describe('Migration AddStrategyPromotionAuditAndComparisonReports — reversibility', () => {
    it('every ADD COLUMN in up() has a matching DROP COLUMN in down()', async () => {
        const upRun = makeQueryRunner();
        const downRun = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(upRun.qr);
        await migration.down(downRun.qr);

        const addedColumns = ['promoted_at', 'archived_at', 'promotion_report_id', 'promotion_note'];

        for (const column of addedColumns) {
            const wasAdded = upRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`"${column}"`) && (sql as string).includes('ADD COLUMN'));
            const wasDropped = downRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`DROP COLUMN`) && (sql as string).includes(`"${column}"`));

            expect(wasAdded).toBe(true);
            expect(wasDropped).toBe(true);
        }
    });

    it('the comparison_reports table created in up() is dropped in down()', async () => {
        const upRun = makeQueryRunner();
        const downRun = makeQueryRunner();
        const migration = new AddStrategyPromotionAuditAndComparisonReports20260527000000();

        await migration.up(upRun.qr);
        await migration.down(downRun.qr);

        const wasCreated = upRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes('CREATE TABLE "comparison_reports"'));
        const wasDropped = downRun.querySpy.mock.calls.some(
            ([sql]) => (sql as string).includes('DROP TABLE') && (sql as string).includes('comparison_reports'),
        );

        expect(wasCreated).toBe(true);
        expect(wasDropped).toBe(true);
    });
});
