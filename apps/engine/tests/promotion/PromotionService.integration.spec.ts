/**
 * PromotionService — integration test (M8 W6, ADR 0016 §2.2).
 *
 * Requires live Postgres. Start with:
 *   docker compose --profile test up -d --wait postgres-test
 *
 * Coverage:
 *   - promote() in a serializable TX archives the prior active row and flips
 *     the candidate to active, populating promotion audit columns.
 *   - the partial unique index uq_strategy_versions_active_per_name rejects a
 *     second active row for the same name.
 *   - reactivate() rolls a previously-archived row back to active, auto-
 *     archiving any current active row of the same name.
 *   - promote() refuses (PromotionRejectedException) when the gate decision is
 *     not 'promote'.
 *   - promote() refuses (Error) when the candidate is not in 'draft' status —
 *     this is the application-layer guard that lives next to the DB invariant.
 */

import { StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { BACKTEST_ARTEFACT_ROOT } from '../../src/backtest/const/backtestConsts';
import { ComparisonReportEntity, StrategyVersionEntity } from '../../src/strategy/entity';
import { ConcurrentPromotionConflictException } from '../../src/promotion/exception/ConcurrentPromotionConflictException';
import { PromotionGateService } from '../../src/promotion/service/PromotionGateService';
import { PromotionService } from '../../src/promotion/service/PromotionService';
import { PromotionRejectedException } from '../../src/promotion/exception/PromotionRejectedException';
import { IPromotionGateOutcome } from '../../src/promotion/interface/IPromotionGateOutcome';
import { getTestDataSource } from '../support/testDataSource';

const UNIQUE_NAME_PREFIX = 'test_promotion_service_';

function buildStrategyRow(name: string, version: number, status: StrategyStatusEnum): Partial<StrategyVersionEntity> {
    return { name, version, direction: StrategyDirectionEnum.MEAN_REVERSION, params: {}, status };
}

function buildPromoteOutcome(versionId: number, reportId: number): IPromotionGateOutcome {
    return {
        versionId,
        reportId,
        decision: 'promote',
        passedCriteria: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        failedCriteria: [],
        evaluatedAt: new Date(),
    };
}

function buildRejectOutcome(versionId: number, reportId: number): IPromotionGateOutcome {
    return {
        versionId,
        reportId,
        decision: 'reject',
        passedCriteria: [],
        failedCriteria: [{ index: 1, name: 'oos_positive_expectancy', threshold: '>0', observed: '-1', severity: 'block' }],
        evaluatedAt: new Date(),
    };
}

describe('PromotionService (integration — requires Postgres)', () => {
    let dataSource: DataSource;
    let strategyRepository: Repository<StrategyVersionEntity>;
    let comparisonRepository: Repository<ComparisonReportEntity>;
    const artefactPaths: string[] = [];

    beforeAll(async () => {
        dataSource = await getTestDataSource();
        strategyRepository = dataSource.getRepository(StrategyVersionEntity);
        comparisonRepository = dataSource.getRepository(ComparisonReportEntity);
    }, 60_000);

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.query(`DELETE FROM "strategy_versions" WHERE "name" LIKE $1`, [`${UNIQUE_NAME_PREFIX}%`]);
            await dataSource.query(`DELETE FROM "comparison_reports" WHERE "run_label" LIKE $1`, [`${UNIQUE_NAME_PREFIX}%`]);
        }

        for (const file of artefactPaths) {
            await fs.unlink(file).catch(() => undefined);
        }
    }, 30_000);

    // Persist a comparison_reports row whose on-disk artefact JSON carries
    // `promotionDecisions[versionId].decision === decision` for every versionId. Used so
    // the W6 R1-B1 paranoid double-check (PromotionService.requireReportPromotesVersion)
    // sees a real artefact and the correct decision per candidate.
    async function createReport(versionIds: number[], decision: 'promote' | 'reject' | 'inconclusive', labelSuffix: string): Promise<number> {
        // PromotionService validates that the artefact resolves inside
        // BACKTEST_ARTEFACT_ROOT (path-traversal defense). That root is frozen
        // at module-load from env, so the artefact must be written under it
        // rather than os.tmpdir().
        const filename = `promotion-service-int-${labelSuffix}-${Date.now()}.json`;
        await fs.mkdir(BACKTEST_ARTEFACT_ROOT, { recursive: true });
        const artefactPath = path.join(BACKTEST_ARTEFACT_ROOT, filename);
        artefactPaths.push(artefactPath);

        const promotionDecisions: Array<[number, { decision: 'promote' | 'reject' | 'inconclusive' }]> = versionIds.map((id) => [id, { decision }]);
        await fs.writeFile(artefactPath, JSON.stringify({ promotionDecisions }), 'utf8');

        const row = await comparisonRepository.save(
            comparisonRepository.create({
                runLabel: `${UNIQUE_NAME_PREFIX}${labelSuffix}_${Date.now()}`,
                fromMs: '1',
                toMs: '2',
                splitPolicy: {},
                folds: [],
                versionIds,
                summary: {},
                artefactUri: artefactPath,
            }),
        );

        return row.id;
    }

    function buildPromotionService(outcome: IPromotionGateOutcome): PromotionService {
        const gate = {
            evaluate: jest.fn(async () => outcome),
        } as unknown as PromotionGateService;

        return new PromotionService(dataSource, gate);
    }

    // M37 (D1.3): the demoted incumbent now rests in SHADOW (not ARCHIVED) so it keeps
    // shadow-logging across the active→shadow transition with no gap (the verified 6-day
    // v1 blackout fix). `archivedAt` is cleared.
    it('promote() demotes the prior active row to SHADOW and flips the candidate to active', async () => {
        const name = `${UNIQUE_NAME_PREFIX}promote_flow_${Date.now()}`;
        const incumbent = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));
        const candidate = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.DRAFT)));
        const reportId = await createReport([candidate.id], 'promote', 'promote_flow');

        const service = buildPromotionService(buildPromoteOutcome(candidate.id, reportId));

        const promoted = await service.promote(candidate.id, reportId, 'first promotion');

        expect(promoted.status).toBe(StrategyStatusEnum.ACTIVE);
        expect(promoted.promotedAt).toBeInstanceOf(Date);
        expect(promoted.promotionReportId).toBe(reportId);
        expect(promoted.promotionNote).toBe('first promotion');

        const reloadedIncumbent = await strategyRepository.findOne({ where: { id: incumbent.id } });
        expect(reloadedIncumbent?.status).toBe(StrategyStatusEnum.SHADOW);
        expect(reloadedIncumbent?.archivedAt).toBeNull();

        const activeRows = await strategyRepository.find({ where: { name, status: StrategyStatusEnum.ACTIVE } });
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0].id).toBe(candidate.id);
    });

    it('promote() refuses with PromotionRejectedException when the gate decision is not promote', async () => {
        const name = `${UNIQUE_NAME_PREFIX}gate_reject_${Date.now()}`;
        const candidate = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.DRAFT)));
        const reportId = await createReport([candidate.id], 'promote', 'gate_reject');

        const service = buildPromotionService(buildRejectOutcome(candidate.id, reportId));

        await expect(service.promote(candidate.id, reportId, 'will reject')).rejects.toBeInstanceOf(PromotionRejectedException);

        const reloaded = await strategyRepository.findOne({ where: { id: candidate.id } });
        expect(reloaded?.status).toBe(StrategyStatusEnum.DRAFT);
    });

    it('promote() refuses when the candidate is not in draft status', async () => {
        const name = `${UNIQUE_NAME_PREFIX}not_draft_${Date.now()}`;
        const archived = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ARCHIVED)));
        const reportId = await createReport([archived.id], 'promote', 'not_draft');

        const service = buildPromotionService(buildPromoteOutcome(archived.id, reportId));

        await expect(service.promote(archived.id, reportId, 'should fail')).rejects.toThrow(/must be draft/);

        const reloaded = await strategyRepository.findOne({ where: { id: archived.id } });
        expect(reloaded?.status).toBe(StrategyStatusEnum.ARCHIVED);
    });

    // M37 (D1.3): reactivate flips an archived (or demoted-shadow) row back to active and
    // demotes any current active row to SHADOW (not ARCHIVED) so the outgoing version keeps
    // shadow-logging with no gap.
    it('reactivate() flips an archived row back to active and demotes any current active row to SHADOW', async () => {
        const name = `${UNIQUE_NAME_PREFIX}reactivate_${Date.now()}`;
        const oldActive = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ARCHIVED)));
        const currentActive = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.ACTIVE)));

        // reactivate() does not consult the comparison_reports artefact; the outcome
        // here is only carried for the unused service.promote() path.
        const service = buildPromotionService(buildPromoteOutcome(oldActive.id, 0));

        const reactivated = await service.reactivate(oldActive.id);

        expect(reactivated.status).toBe(StrategyStatusEnum.ACTIVE);
        expect(reactivated.archivedAt).toBeNull();
        expect(reactivated.promotedAt).toBeInstanceOf(Date);

        const reloadedCurrent = await strategyRepository.findOne({ where: { id: currentActive.id } });
        expect(reloadedCurrent?.status).toBe(StrategyStatusEnum.SHADOW);
        expect(reloadedCurrent?.archivedAt).toBeNull();

        const activeRows = await strategyRepository.find({ where: { name, status: StrategyStatusEnum.ACTIVE } });
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0].id).toBe(oldActive.id);
    });

    // M37 (D1.3): a demoted incumbent now rests in SHADOW and must be reactivatable from
    // there — the previously-active version can be flipped back without first archiving it.
    it('reactivate() accepts a SHADOW (demoted-incumbent) target and flips it back to active', async () => {
        const name = `${UNIQUE_NAME_PREFIX}reactivate_shadow_${Date.now()}`;
        const demotedShadow = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.SHADOW)));

        const service = buildPromotionService(buildPromoteOutcome(demotedShadow.id, 0));

        const reactivated = await service.reactivate(demotedShadow.id);

        expect(reactivated.status).toBe(StrategyStatusEnum.ACTIVE);
        expect(reactivated.archivedAt).toBeNull();
        expect(reactivated.promotedAt).toBeInstanceOf(Date);
    });

    it('reactivate() refuses when the target row is a draft (neither archived nor shadow)', async () => {
        const name = `${UNIQUE_NAME_PREFIX}reactivate_not_archived_${Date.now()}`;
        const draft = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.DRAFT)));

        const service = buildPromotionService(buildPromoteOutcome(draft.id, 0));

        await expect(service.reactivate(draft.id)).rejects.toThrow(/must be archived or shadow/);
    });

    // Paired regression test for R1-B1 (ADR 0016 §2.2 step 2): if the comparison report's
    // artefact JSON does NOT promote the candidate, the gate's green outcome alone must
    // not be enough — promote() must reject. This is the paranoid double-check that
    // prevents an operator wiring a wrong reportId past a stale green gate.
    it('promote() rejects when the report artefact does not promote the candidate (R1-B1)', async () => {
        const name = `${UNIQUE_NAME_PREFIX}artefact_not_promote_${Date.now()}`;
        const candidate = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.DRAFT)));
        const reportId = await createReport([candidate.id], 'inconclusive', 'artefact_not_promote');

        const service = buildPromotionService(buildPromoteOutcome(candidate.id, reportId));

        await expect(service.promote(candidate.id, reportId, 'should fail')).rejects.toThrow(/does not promote version/);

        const reloaded = await strategyRepository.findOne({ where: { id: candidate.id } });
        expect(reloaded?.status).toBe(StrategyStatusEnum.DRAFT);
    });

    // Paired regression test for R1-B1: report.versionIds does not include the candidate.
    it('promote() rejects when the report versionIds does not include the candidate (R1-B1)', async () => {
        const name = `${UNIQUE_NAME_PREFIX}versionids_missing_${Date.now()}`;
        const candidate = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.DRAFT)));
        // Report references a different version id only.
        const unrelatedId = candidate.id + 1_000_000;
        const reportId = await createReport([unrelatedId], 'promote', 'versionids_missing');

        const service = buildPromotionService(buildPromoteOutcome(candidate.id, reportId));

        await expect(service.promote(candidate.id, reportId, 'should fail')).rejects.toThrow(/does not include version/);

        const reloaded = await strategyRepository.findOne({ where: { id: candidate.id } });
        expect(reloaded?.status).toBe(StrategyStatusEnum.DRAFT);
    });

    // R3-M1: concurrent promote() of TWO DIFFERENT draft candidates of the same `name`
    // must surface the loser as a typed ConcurrentPromotionConflictException — never
    // a raw TypeORM QueryFailedError leaking pg implementation details across the
    // module boundary.
    //
    // Forcing deterministic contention: under jest's single-threaded event loop two
    // promote() calls launched via Promise.all often serialise naturally on the
    // shared TypeORM pool (one fully commits before the other acquires its first
    // lock). To deterministically force overlap we use a tiny barrier: start TX A,
    // open its SERIALIZABLE TX manually, take SELECT FOR UPDATE on the incumbent,
    // then start TX B (via the service) and let it block on the incumbent's row
    // lock. While B is blocked, TX A finishes its archive+flip path; when TX A
    // commits, TX B's snapshot is stale and PostgreSQL aborts B with SQLSTATE 40001
    // (serialization_failure). The partial unique index is the back-stop if SSI
    // somehow misses (SQLSTATE 23505) — both paths map to the same domain code.
    it('promote() x promote() concurrently on the same name surfaces ConcurrentPromotionConflictException for the loser (R3-M1)', async () => {
        const name = `${UNIQUE_NAME_PREFIX}concurrent_promote_${Date.now()}`;
        const incumbent = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));
        const candidateA = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.DRAFT)));
        const candidateB = await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 3, StrategyStatusEnum.DRAFT)));
        const reportIdA = await createReport([candidateA.id], 'promote', 'concurrent_A');
        const reportIdB = await createReport([candidateB.id], 'promote', 'concurrent_B');

        // TX A: manually open SERIALIZABLE, take SELECT FOR UPDATE on the incumbent
        // to occupy the row lock. TX B (via the service) will block here.
        const txA = dataSource.createQueryRunner();
        await txA.connect();
        await txA.startTransaction('SERIALIZABLE');

        try {
            await txA.manager.createQueryBuilder(StrategyVersionEntity, 'sv').setLock('pessimistic_write').where('sv.id = :id', { id: incumbent.id }).getOne();

            const serviceB = buildPromotionService(buildPromoteOutcome(candidateB.id, reportIdB));
            const promiseB = serviceB.promote(candidateB.id, reportIdB, 'concurrent B'); // blocks on incumbent row lock

            // Give B a moment to reach its lock-wait state, then complete A's work
            // exactly as the service would: archive incumbent + flip candidateA.
            await new Promise((resolve) => setTimeout(resolve, 50));

            await txA.manager.update(StrategyVersionEntity, { id: incumbent.id }, { status: StrategyStatusEnum.ARCHIVED, archivedAt: new Date() });
            await txA.manager.update(
                StrategyVersionEntity,
                { id: candidateA.id },
                { status: StrategyStatusEnum.ACTIVE, promotedAt: new Date(), promotionReportId: reportIdA },
            );
            await txA.commitTransaction();

            // Now B unblocks: its snapshot is from before A committed; SERIALIZABLE
            // aborts it.
            const outcomeB = await promiseB
                .then((value) => ({ kind: 'fulfilled' as const, value }))
                .catch((reason: unknown) => ({ kind: 'rejected' as const, reason }));

            expect(outcomeB.kind).toBe('rejected');

            if (outcomeB.kind === 'rejected') {
                expect(outcomeB.reason).toBeInstanceOf(ConcurrentPromotionConflictException);
                expect((outcomeB.reason as ConcurrentPromotionConflictException).code).toBe('PROMOTION_CONCURRENT_CONFLICT');
            }
        } finally {
            if (txA.isTransactionActive) {
                await txA.rollbackTransaction();
            }
            await txA.release();
        }

        // The DB ends in a single-active state for this name (the W2 invariant).
        // candidateA is the winner, candidateB stayed DRAFT, original incumbent is archived.
        const activeRows = await strategyRepository.find({ where: { name, status: StrategyStatusEnum.ACTIVE } });
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0].id).toBe(candidateA.id);

        const loser = await strategyRepository.findOne({ where: { id: candidateB.id } });
        expect(loser?.status).toBe(StrategyStatusEnum.DRAFT);

        const reloadedIncumbent = await strategyRepository.findOne({ where: { id: incumbent.id } });
        expect(reloadedIncumbent?.status).toBe(StrategyStatusEnum.ARCHIVED);
    }, 30_000);

    it('the DB-level partial unique index defends against any concurrent escape (sanity)', async () => {
        // Belt-and-braces — the application-layer TX guarantees one-active, but
        // the partial unique index is the ultimate fence. A direct insert that
        // bypasses the service must still be rejected.
        const name = `${UNIQUE_NAME_PREFIX}db_fence_${Date.now()}`;
        await strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 1, StrategyStatusEnum.ACTIVE)));

        await expect(strategyRepository.save(strategyRepository.create(buildStrategyRow(name, 2, StrategyStatusEnum.ACTIVE)))).rejects.toBeInstanceOf(
            QueryFailedError,
        );
    });
});
