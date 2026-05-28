/**
 * Adversarial tests for PromotionService TX-safety (M8 W8 QA / ADR 0016 §2.2).
 *
 * Cluster: idempotent-failure modes exercised through mocks (unit tests). The
 * critical concurrent-promote test for the partial unique index lives in the
 * integration spec because it requires a real Postgres serializable transaction.
 */

import { StrategyStatusEnum } from '@bot/shared';
import { DataSource } from 'typeorm';

import { ComparisonReportEntity } from '../../../strategy/entity/ComparisonReportEntity';
import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { PromotionRejectedException } from '../../exception/PromotionRejectedException';
import { IPromotionGateOutcome } from '../../interface/IPromotionGateOutcome';
import { PromotionGateService } from '../PromotionGateService';
import { PromotionService } from '../PromotionService';

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildVersion(id: number, status: StrategyStatusEnum, name = 'adv'): StrategyVersionEntity {
    return {
        id,
        name,
        version: id,
        direction: 'MEAN_REVERSION',
        params: {},
        status,
        parentVersionId: null,
        promotedAt: null,
        archivedAt: null,
        promotionReportId: null,
        promotionNote: null,
        createdAt: new Date(),
    } as unknown as StrategyVersionEntity;
}

function buildRejectOutcome(versionId: number, reportId: number): IPromotionGateOutcome {
    return {
        versionId,
        reportId,
        decision: 'reject',
        passedCriteria: [],
        failedCriteria: [{ index: 1, name: 'oos_positive_expectancy', threshold: '>0', observed: '-1', severity: 'block' }],
        inconclusiveReason: undefined,
        evaluatedAt: new Date(),
    };
}

function buildPromoteOutcome(versionId: number, reportId: number): IPromotionGateOutcome {
    return {
        versionId,
        reportId,
        decision: 'promote',
        passedCriteria: [1, 2, 3, 4, 5, 6, 8, 10, 11, 12],
        failedCriteria: [],
        inconclusiveReason: undefined,
        evaluatedAt: new Date(),
    };
}

// Build a manager mock whose getOne returns the given entity for pessimistic_write queries.
function _buildManagerMock(candidate: StrategyVersionEntity, incumbent: StrategyVersionEntity | null, reportExists: boolean): any {
    return {
        createQueryBuilder: jest.fn().mockImplementation(() => ({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockImplementation(async () => {
                // Very naive: first call returns candidate, second returns incumbent.
                // A production-grade test would use a stateful mock.
                return null;
            }),
        })),
        findOne: jest.fn().mockResolvedValue(reportExists ? ({ id: 99 } as ComparisonReportEntity) : null),
        save: jest.fn().mockImplementation(async (_entity: unknown, row: StrategyVersionEntity) => row),
    };
}

function buildDataSource(candidate: StrategyVersionEntity, incumbent: StrategyVersionEntity | null, reportExists = true): DataSource {
    let callCount = 0;

    const manager = {
        createQueryBuilder: jest.fn().mockImplementation(() => {
            callCount += 1;
            return {
                setLock: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockImplementation(async () => {
                    // First call → candidate query, second → incumbent query.
                    if (callCount === 1) return candidate;
                    return incumbent;
                }),
            };
        }),
        findOne: jest.fn().mockResolvedValue(reportExists ? ({ id: 99 } as unknown as ComparisonReportEntity) : null),
        save: jest.fn().mockImplementation(async (_entity: unknown, row: StrategyVersionEntity) => ({ ...row })),
    };

    return {
        transaction: jest.fn().mockImplementation(async (_isolationLevel: string, fn: (m: typeof manager) => Promise<unknown>) => {
            callCount = 0; // reset per transaction
            return fn(manager);
        }),
    } as unknown as DataSource;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('PromotionService — adversarial unit', () => {
    describe('promote — gate rejects', () => {
        it('throws PromotionRejectedException when gate returns decision=reject', async () => {
            const versionId = 300;
            const reportId = 99;
            const rejectOutcome = buildRejectOutcome(versionId, reportId);

            const gate = {
                evaluate: jest.fn().mockResolvedValue(rejectOutcome),
            } as unknown as PromotionGateService;

            const dataSource = buildDataSource(buildVersion(versionId, StrategyStatusEnum.DRAFT), null);
            const service = new PromotionService(dataSource, gate);

            await expect(service.promote(versionId, reportId, 'test note')).rejects.toThrow(PromotionRejectedException);
        });

        it('PromotionRejectedException carries the structured outcome', async () => {
            const versionId = 301;
            const reportId = 99;
            const rejectOutcome = buildRejectOutcome(versionId, reportId);

            const gate = {
                evaluate: jest.fn().mockResolvedValue(rejectOutcome),
            } as unknown as PromotionGateService;

            const dataSource = buildDataSource(buildVersion(versionId, StrategyStatusEnum.DRAFT), null);
            const service = new PromotionService(dataSource, gate);

            try {
                await service.promote(versionId, reportId, 'test');
                fail('expected PromotionRejectedException');
            } catch (cause) {
                expect(cause).toBeInstanceOf(PromotionRejectedException);
                expect((cause as PromotionRejectedException).outcome.decision).toBe('reject');
                expect((cause as PromotionRejectedException).outcome.versionId).toBe(versionId);
            }
        });
    });

    describe('reactivate — already-active guard', () => {
        it('throws when target row is ACTIVE (not ARCHIVED)', async () => {
            const activeVersion = buildVersion(400, StrategyStatusEnum.ACTIVE);

            const gate = { evaluate: jest.fn() } as unknown as PromotionGateService;

            // Override the transaction to return the active row directly.
            let callCount = 0;
            const manager = {
                createQueryBuilder: jest.fn().mockImplementation(() => ({
                    setLock: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    andWhere: jest.fn().mockReturnThis(),
                    getOne: jest.fn().mockImplementation(async () => {
                        callCount += 1;
                        return callCount === 1 ? activeVersion : null;
                    }),
                })),
                findOne: jest.fn().mockResolvedValue(null),
                save: jest.fn(),
            };

            const ds = {
                transaction: jest.fn().mockImplementation(async (_: string, fn: (m: typeof manager) => Promise<unknown>) => {
                    callCount = 0;
                    return fn(manager);
                }),
            } as unknown as DataSource;

            const service = new PromotionService(ds, gate);

            // PromotionService.lockArchivedForReactivate throws when status !== ARCHIVED.
            await expect(service.reactivate(activeVersion.id)).rejects.toThrow(/must be archived/i);
        });
    });

    describe('reactivate — not found guard', () => {
        it('throws when the version id does not exist', async () => {
            const gate = { evaluate: jest.fn() } as unknown as PromotionGateService;

            const manager = {
                createQueryBuilder: jest.fn().mockImplementation(() => ({
                    setLock: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    andWhere: jest.fn().mockReturnThis(),
                    getOne: jest.fn().mockResolvedValue(null), // not found
                })),
                findOne: jest.fn().mockResolvedValue(null),
                save: jest.fn(),
            };

            const ds = {
                transaction: jest.fn().mockImplementation(async (_: string, fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
            } as unknown as DataSource;

            const service = new PromotionService(ds, gate);

            await expect(service.reactivate(999)).rejects.toThrow(/not found/i);
        });
    });

    describe('promote TX — missing report inside transaction', () => {
        it('throws when the comparison_reports row is missing inside the transaction', async () => {
            const versionId = 500;
            const reportId = 98;
            const candidate = buildVersion(versionId, StrategyStatusEnum.DRAFT);

            const promoteOutcome = buildPromoteOutcome(versionId, reportId);
            const gate = {
                evaluate: jest.fn().mockResolvedValue(promoteOutcome),
            } as unknown as PromotionGateService;

            let callCount = 0;
            const manager = {
                createQueryBuilder: jest.fn().mockImplementation(() => ({
                    setLock: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    andWhere: jest.fn().mockReturnThis(),
                    getOne: jest.fn().mockImplementation(async () => {
                        callCount += 1;
                        return callCount === 1 ? candidate : null;
                    }),
                })),
                findOne: jest.fn().mockResolvedValue(null), // comparison report missing
                save: jest.fn(),
            };

            const ds = {
                transaction: jest.fn().mockImplementation(async (_: string, fn: (m: typeof manager) => Promise<unknown>) => {
                    callCount = 0;
                    return fn(manager);
                }),
            } as unknown as DataSource;

            const service = new PromotionService(ds, gate);

            await expect(service.promote(versionId, reportId, 'note')).rejects.toThrow(/comparison report/i);
        });
    });

    describe('promote TX — non-draft candidate', () => {
        it('throws when candidate is already ACTIVE (must be DRAFT)', async () => {
            const versionId = 600;
            const reportId = 97;
            const activeCandidate = buildVersion(versionId, StrategyStatusEnum.ACTIVE);

            const promoteOutcome = buildPromoteOutcome(versionId, reportId);
            const gate = {
                evaluate: jest.fn().mockResolvedValue(promoteOutcome),
            } as unknown as PromotionGateService;

            let callCount = 0;
            const manager = {
                createQueryBuilder: jest.fn().mockImplementation(() => ({
                    setLock: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    andWhere: jest.fn().mockReturnThis(),
                    getOne: jest.fn().mockImplementation(async () => {
                        callCount += 1;
                        return callCount === 1 ? activeCandidate : null;
                    }),
                })),
                findOne: jest.fn().mockResolvedValue({ id: reportId } as unknown as ComparisonReportEntity),
                save: jest.fn(),
            };

            const ds = {
                transaction: jest.fn().mockImplementation(async (_: string, fn: (m: typeof manager) => Promise<unknown>) => {
                    callCount = 0;
                    return fn(manager);
                }),
            } as unknown as DataSource;

            const service = new PromotionService(ds, gate);

            await expect(service.promote(versionId, reportId, 'note')).rejects.toThrow(/must be draft/i);
        });
    });
});
