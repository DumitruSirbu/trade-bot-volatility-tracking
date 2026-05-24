/**
 * ComparisonReportRepository + partial unique index — integration test (M8 W2).
 *
 * Requires live Postgres. Start with:
 *   DB_PORT=5433 docker compose up -d postgres
 *
 * Coverage:
 *   - createReport persists run_label, from_ms, to_ms, split_policy, folds,
 *     version_ids[], summary, artefact_uri; jsonb fields round-trip; integer[]
 *     round-trips as number[]; bigint columns are returned as string by pg.
 *   - findById hydrates the same record.
 *   - findMostRecent returns rows in DESC created_at order, bounded by `limit`.
 *   - The partial unique index uq_strategy_versions_active_per_name is enforced
 *     at the DB level: inserting a second row with status='active' for the same
 *     name FAILS with a unique-violation; archived/draft rows do NOT trip it.
 */

import { StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';
import { DataSource, Repository } from 'typeorm';

import { ComparisonReportEntity, StrategyVersionEntity } from '../../src/strategy/entity';
import { ComparisonReportRepository } from '../../src/strategy/repository/ComparisonReportRepository';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';

const TEST_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';

const UNIQUE_NAME_PREFIX = 'test_promotion_audit_';

function uniqueStrategyName(suffix: string): string {
    // Tests are isolated from one another and from prior runs by a unique prefix +
    // a per-test suffix. cleanup deletes any rows created under the prefix.
    return `${UNIQUE_NAME_PREFIX}${suffix}`;
}

function buildStrategyRow(name: string, version: number, status: StrategyStatusEnum): Partial<StrategyVersionEntity> {
    // Helper centralises the typing so the rest of the spec stays readable. The
    // Partial<...> annotation pins the create() overload to the singular signature.
    return { name, version, direction: StrategyDirectionEnum.MEAN_REVERSION, params: {}, status };
}

describe('ComparisonReportRepository (integration — requires Postgres)', () => {
    let dataSource: DataSource;
    let repo: ComparisonReportRepository;
    let strategyRepository: Repository<StrategyVersionEntity>;

    beforeAll(async () => {
        const options = buildDataSourceOptions(TEST_DB_URL);
        dataSource = new DataSource(options);
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });

        const ormRepo = dataSource.getRepository(ComparisonReportEntity);
        repo = new ComparisonReportRepository(ormRepo);
        strategyRepository = dataSource.getRepository(StrategyVersionEntity);
    }, 60_000);

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.query(`DELETE FROM "strategy_versions" WHERE "name" LIKE $1`, [`${UNIQUE_NAME_PREFIX}%`]);
            await dataSource.query(`DELETE FROM "comparison_reports" WHERE "run_label" LIKE $1`, [`${UNIQUE_NAME_PREFIX}%`]);
            await dataSource.destroy();
        }
    }, 30_000);

    describe('createReport / findById round-trip', () => {
        it('persists jsonb, integer[], and bigint fields and hydrates them back', async () => {
            const splitPolicy = { trainBars: 60, validationBars: 14, oosBars: 14, stepBars: 14, mode: 'rolling' };
            const folds = [{ foldIndex: 0, trainFromMs: 1, trainToMs: 2, validationFromMs: 3, validationToMs: 4, oosFromMs: 5, oosToMs: 6 }];
            const summary = { totalTrades: 42, winners: 25 };

            const created = await repo.createReport({
                runLabel: `${UNIQUE_NAME_PREFIX}roundtrip_${Date.now()}`,
                fromMs: '1700000000000',
                toMs: '1700864000000',
                splitPolicy,
                folds,
                versionIds: [101, 102, 103],
                summary,
                artefactUri: '/tmp/comparison-roundtrip.json',
            });

            expect(created.id).toBeGreaterThan(0);

            const reloaded = await repo.findById(created.id);

            expect(reloaded).not.toBeNull();
            expect(reloaded!.runLabel).toBe(created.runLabel);
            expect(reloaded!.splitPolicy).toEqual(splitPolicy);
            expect(reloaded!.folds).toEqual(folds);
            expect(reloaded!.versionIds).toEqual([101, 102, 103]);
            expect(reloaded!.summary).toEqual(summary);
            expect(reloaded!.artefactUri).toBe('/tmp/comparison-roundtrip.json');
            // bigint columns are returned as string by node-postgres.
            expect(reloaded!.fromMs).toBe('1700000000000');
            expect(reloaded!.toMs).toBe('1700864000000');
            expect(reloaded!.createdAt).toBeInstanceOf(Date);
        });
    });

    describe('findMostRecent', () => {
        it('returns rows in DESC created_at order, bounded by limit', async () => {
            const label = `${UNIQUE_NAME_PREFIX}most_recent_${Date.now()}`;

            const first = await repo.createReport({
                runLabel: `${label}_a`,
                fromMs: '1',
                toMs: '2',
                splitPolicy: {},
                folds: [],
                versionIds: [],
                summary: {},
                artefactUri: '/tmp/a.json',
            });
            const second = await repo.createReport({
                runLabel: `${label}_b`,
                fromMs: '1',
                toMs: '2',
                splitPolicy: {},
                folds: [],
                versionIds: [],
                summary: {},
                artefactUri: '/tmp/b.json',
            });

            const recent = await repo.findMostRecent(10);
            const idsInOrder = recent.map((row) => row.id);
            const firstPos = idsInOrder.indexOf(first.id);
            const secondPos = idsInOrder.indexOf(second.id);

            expect(secondPos).toBeGreaterThanOrEqual(0);
            expect(firstPos).toBeGreaterThanOrEqual(0);
            // second was created after first, so it must appear earlier (DESC).
            expect(secondPos).toBeLessThan(firstPos);

            const bounded = await repo.findMostRecent(1);

            expect(bounded).toHaveLength(1);
        });
    });

    describe('partial unique index uq_strategy_versions_active_per_name', () => {
        it('rejects a second row with status=active for the same name (DB-level)', async () => {
            const name = uniqueStrategyName(`active_dup_${Date.now()}`);

            await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));

            // A second active row for the same name must be rejected by the DB.
            await expect(strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.ACTIVE)))).rejects.toThrow(
                /uq_strategy_versions_active_per_name|duplicate key|unique constraint/i,
            );
        });

        it('does NOT reject archived or draft rows for the same name', async () => {
            const name = uniqueStrategyName(`mixed_status_${Date.now()}`);

            await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));
            await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.DRAFT)));
            await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 3, StrategyStatusEnum.ARCHIVED)));

            const rows = await strategyRepository.find({ where: { name } });

            expect(rows).toHaveLength(3);
        });

        it('allows a previously-active row to be archived and a different row promoted to active', async () => {
            const name = uniqueStrategyName(`rotation_${Date.now()}`);

            const v1 = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));

            v1.status = StrategyStatusEnum.ARCHIVED;
            await strategyRepository.save(v1);

            // Now a different version can take the active slot — no unique violation.
            await expect(strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.ACTIVE)))).resolves.toBeDefined();
        });
    });
});
