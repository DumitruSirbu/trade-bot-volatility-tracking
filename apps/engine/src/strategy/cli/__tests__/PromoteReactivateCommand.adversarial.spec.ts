/**
 * Adversarial tests for PromoteCommand / ReactivateCommand CLI argument parsing
 * and runtime rejection paths (M8 W8 QA / ADR 0019 §2.5).
 *
 * Cluster: bad-args for both commands, promote with archived target,
 * reactivate with invalid id.
 */

import { StrategyStatusEnum } from '@bot/shared';

import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { PromotionRejectedException } from '../../../promotion/exception/PromotionRejectedException';
import { IPromotionGateOutcome } from '../../../promotion/interface/IPromotionGateOutcome';
import { PromotionService } from '../../../promotion/service/PromotionService';
import { StrategyVersionRepository } from '../../repository/StrategyVersionRepository';
import { parsePromoteArgs, PromoteCommand } from '../PromoteCommand';
import { parseReactivateArgs, ReactivateCommand } from '../ReactivateCommand';

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildArchivedOutcome(versionId: number): IPromotionGateOutcome {
    return {
        versionId,
        reportId: 0,
        decision: 'reject',
        passedCriteria: [],
        failedCriteria: [{ index: 0, name: 'status_check', threshold: 'draft', observed: 'archived', severity: 'block' }],
        inconclusiveReason: undefined,
        evaluatedAt: new Date(),
    };
}

function buildArchivedVersion(id: number): StrategyVersionEntity {
    return {
        id,
        name: 'adv-promo',
        version: id,
        direction: 'MEAN_REVERSION',
        params: {},
        status: StrategyStatusEnum.ARCHIVED,
        parentVersionId: null,
        promotedAt: null,
        archivedAt: new Date(),
        promotionReportId: null,
        promotionNote: null,
        createdAt: new Date(),
    } as unknown as StrategyVersionEntity;
}

// ─── parsePromoteArgs ─────────────────────────────────────────────────────────

describe('parsePromoteArgs — adversarial', () => {
    it('throws when --version-id is not a positive integer', () => {
        expect(() =>
            parsePromoteArgs(['--version-id=0', '--report-id=5', '--note=test']),
        ).toThrow(/positive integer/i);
    });

    it('throws when --report-id is missing', () => {
        expect(() =>
            parsePromoteArgs(['--version-id=1', '--note=test']),
        ).toThrow(/--report-id is required/i);
    });

    it('throws when --note is empty', () => {
        expect(() =>
            parsePromoteArgs(['--version-id=1', '--report-id=2', '--note=']),
        ).toThrow(/--note must be non-empty/i);
    });

    it('throws when a flag uses key-only form without =value', () => {
        expect(() =>
            parsePromoteArgs(['--version-id', '--report-id=2', '--note=n']),
        ).toThrow(/must use --key=value form/i);
    });
});

// ─── PromoteCommand.execute — gate rejects archived candidate ─────────────────

describe('PromoteCommand.execute — adversarial', () => {
    it('returns success=false with a rejection table when the gate rejects', async () => {
        const versionId = 700;
        const reportId = 50;
        const rejectOutcome = buildArchivedOutcome(versionId);

        const promotionService = {
            promote: jest.fn().mockRejectedValue(new PromotionRejectedException(rejectOutcome)),
        } as unknown as PromotionService;

        const command = new PromoteCommand(promotionService);
        const result = await command.execute({ versionId, reportId, note: 'test' });

        expect(result.success).toBe(false);
        expect((result as any).rejectionTable).toContain('rejected');
    });

    it('re-throws unexpected errors (not PromotionRejectedException)', async () => {
        const promotionService = {
            promote: jest.fn().mockRejectedValue(new Error('db connection lost')),
        } as unknown as PromotionService;

        const command = new PromoteCommand(promotionService);

        await expect(command.execute({ versionId: 1, reportId: 1, note: 'test' })).rejects.toThrow('db connection lost');
    });
});

// ─── parseReactivateArgs ──────────────────────────────────────────────────────

describe('parseReactivateArgs — adversarial', () => {
    it('throws when --version-id is not a positive integer', () => {
        expect(() =>
            parseReactivateArgs(['--version-id=-5']),
        ).toThrow(/positive integer/i);
    });

    it('throws when --version-id is missing', () => {
        expect(() =>
            parseReactivateArgs([]),
        ).toThrow(/--version-id is required/i);
    });

    it('throws when a positional argument appears instead of a flag', () => {
        expect(() =>
            parseReactivateArgs(['123']),
        ).toThrow(/unexpected positional argument/i);
    });
});

// ─── ReactivateCommand.execute — not-found path ───────────────────────────────

describe('ReactivateCommand.execute — adversarial', () => {
    it('throws when the version id does not exist in the repository', async () => {
        const strategyVersionRepository = {
            findById: jest.fn().mockResolvedValue(null),
        } as unknown as StrategyVersionRepository;

        const promotionService = {
            reactivate: jest.fn(),
        } as unknown as PromotionService;

        const command = new ReactivateCommand(promotionService, strategyVersionRepository);

        await expect(command.execute({ versionId: 9999 })).rejects.toThrow(/not found/i);
    });

    it('re-throws when PromotionService.reactivate throws already-active error', async () => {
        const archivedVersion = buildArchivedVersion(800);

        const strategyVersionRepository = {
            findById: jest.fn().mockResolvedValue(archivedVersion),
        } as unknown as StrategyVersionRepository;

        const promotionService = {
            reactivate: jest.fn().mockRejectedValue(new Error('PromotionService: version 800 must be archived to reactivate (was active)')),
        } as unknown as PromotionService;

        const command = new ReactivateCommand(promotionService, strategyVersionRepository);

        await expect(command.execute({ versionId: 800 })).rejects.toThrow(/must be archived/i);
    });
});
