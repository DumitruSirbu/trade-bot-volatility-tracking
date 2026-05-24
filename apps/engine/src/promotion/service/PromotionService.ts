import { StrategyStatusEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import { relative as relativePath, resolve as resolvePath } from 'path';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { BACKTEST_ARTEFACT_ROOT } from '../../backtest/const/backtestConsts';
import { ComparisonReportEntity, StrategyVersionEntity } from '../../strategy/entity';
import { ArtefactPathOutsideRootException } from '../exception/ArtefactPathOutsideRootException';
import { ConcurrentPromotionConflictException } from '../exception/ConcurrentPromotionConflictException';
import { PromotionRejectedException } from '../exception/PromotionRejectedException';
import { PromotionStateException } from '../exception/PromotionStateException';
import { IPromotionGateOutcome } from '../interface/IPromotionGateOutcome';
import { PromotionGateService } from './PromotionGateService';

// PG SQLSTATEs that signal a concurrent promote race on the same `name`:
//   - 23505 unique_violation: the partial unique index
//     `uq_strategy_versions_active_per_name` rejected the loser at INSERT/UPDATE
//     time. We further match the constraint name so any other unique violation
//     (a different index someone might add later) propagates untouched.
//   - 40001 serialization_failure: under SERIALIZABLE isolation, Postgres SSI
//     can detect the read/write dependency cycle between two concurrent
//     promote() transactions (both reading "no active row for name" then both
//     trying to flip a row to active) and abort one with a serialization
//     failure BEFORE it reaches the unique-index check. This is the empirically
//     observed path for the two-candidate-same-name race (R3-M1 test).
const PG_UNIQUE_VIOLATION_CODE = '23505';
const PG_SERIALIZATION_FAILURE_CODE = '40001';
const ACTIVE_PER_NAME_CONSTRAINT = 'uq_strategy_versions_active_per_name';

// Mechanism layer for ADR 0016 §2.2 promotion / reactivation. The gate decides
// "may this row be promoted"; this service performs the state transition under
// a serializable transaction so the DB-level partial unique index (M8 W2,
// `uq_strategy_versions_active_per_name`) and the application-level invariants
// agree.
//
// Promote flow (ADR 0016 §2.2):
//   1. Run PromotionGateService.evaluate; any non-'promote' outcome rejects
//      with PromotionRejectedException carrying the structured outcome.
//   2. Open serializable TX.
//   3. SELECT FOR UPDATE the candidate + the current active row (if any) for
//      the same name, so a concurrent promote on the same name serialises.
//   4. Validate candidate.status === 'draft', the report row exists, the report's
//      version_ids includes this versionId, and the report's artefact JSON
//      `promotionDecisions[versionId].decision === 'promote'` (ADR 0016 §2.2 step 2 —
//      paranoid double-check: a green gate alone is not enough; the operator-supplied
//      report must also conclude 'promote' for this candidate).
//   5. Archive the prior active row (status='archived', archived_at=now).
//   6. Flip candidate (status='active', promoted_at=now, promotion_report_id,
//      promotion_note).
//   7. Commit. The partial unique index guarantees no double-active escapes.
//
// Reactivate flow is the symmetric inverse: archive any current active row,
// flip the chosen archived row back to 'active' with archived_at cleared and
// promoted_at refreshed.
@Injectable()
export class PromotionService {
    private readonly logger = new Logger(PromotionService.name);

    // Documented deviation from the repository-pattern rule in
    // `docs/best-practices/code-conventions.md` §"Repository Pattern":
    //
    // `BaseRepository<T>` deliberately does not expose a transaction-boundary API.
    // This service needs ADR 0016 §2.2 step 2 semantics — open a SERIALIZABLE
    // transaction, take SELECT FOR UPDATE locks on the candidate row + any
    // current active row for the same `name`, flip statuses, and commit so the
    // partial unique index `uq_strategy_versions_active_per_name` (M8 W2) and
    // the application-level invariants agree.
    //
    // Implementing this with the per-repository `BaseRepository` API would
    // require either threading an `EntityManager` through every repository
    // method (leaking transaction state everywhere) or a fragile cross-repo
    // dance without a shared lock scope. Injecting `DataSource` directly here
    // is the narrow, intentional exception — confined to this one service.
    //
    // **Do not propagate this pattern casually.** Any other service that thinks
    // it needs `@InjectDataSource()` almost certainly does not: it should
    // depend on its repositories instead. See ADR 0016 §2.2 for the rationale.
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly promotionGate: PromotionGateService,
    ) {}

    async promote(versionId: number, reportId: number, note: string): Promise<StrategyVersionEntity> {
        const outcome = await this.promotionGate.evaluate(versionId, reportId);

        if (outcome.decision !== 'promote') {
            throw new PromotionRejectedException(outcome);
        }

        return this.executePromotion(versionId, reportId, note, outcome);
    }

    private async executePromotion(versionId: number, reportId: number, note: string, outcome: IPromotionGateOutcome): Promise<StrategyVersionEntity> {
        let candidateName = '';

        try {
            return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
                const candidate = await this.lockCandidateForPromote(manager, versionId);
                candidateName = candidate.name;
                const incumbent = await this.lockActiveByName(manager, candidate.name, candidate.id);

                const reportRow = await this.requireReportRow(manager, reportId);
                await this.requireReportPromotesVersion(reportRow, versionId);

                if (incumbent !== null) {
                    incumbent.status = StrategyStatusEnum.ARCHIVED;
                    incumbent.archivedAt = new Date();
                    await manager.save(StrategyVersionEntity, incumbent);
                }

                candidate.status = StrategyStatusEnum.ACTIVE;
                candidate.promotedAt = new Date();
                candidate.archivedAt = null;
                candidate.promotionReportId = reportId;
                candidate.promotionNote = note;

                const saved = await manager.save(StrategyVersionEntity, candidate);

                this.logger.log(`promoted version=${versionId} name=${candidate.name} reportId=${reportId} archivedIncumbent=${incumbent?.id ?? 'none'} criteriaPassed=${outcome.passedCriteria.length}`);

                return saved;
            });
        } catch (cause) {
            if (isActivePerNameUniqueViolation(cause)) {
                this.logger.warn(`promotion concurrent conflict versionId=${versionId} name='${candidateName}': ${(cause as Error).message}`);
                throw new ConcurrentPromotionConflictException(candidateName, versionId, cause);
            }

            throw cause;
        }
    }

    async reactivate(archivedVersionId: number): Promise<StrategyVersionEntity> {
        let targetName = '';

        try {
            return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
                const target = await this.lockArchivedForReactivate(manager, archivedVersionId);
                targetName = target.name;
                const incumbent = await this.lockActiveByName(manager, target.name, target.id);

                if (incumbent !== null) {
                    incumbent.status = StrategyStatusEnum.ARCHIVED;
                    incumbent.archivedAt = new Date();
                    await manager.save(StrategyVersionEntity, incumbent);
                }

                target.status = StrategyStatusEnum.ACTIVE;
                target.promotedAt = new Date();
                target.archivedAt = null;

                const saved = await manager.save(StrategyVersionEntity, target);

                this.logger.log(`reactivated version=${archivedVersionId} name=${target.name} archivedIncumbent=${incumbent?.id ?? 'none'}`);

                return saved;
            });
        } catch (cause) {
            if (isActivePerNameUniqueViolation(cause)) {
                this.logger.warn(`reactivation concurrent conflict versionId=${archivedVersionId} name='${targetName}': ${(cause as Error).message}`);
                throw new ConcurrentPromotionConflictException(targetName, archivedVersionId, cause);
            }

            throw cause;
        }
    }

    private async lockCandidateForPromote(manager: EntityManager, versionId: number): Promise<StrategyVersionEntity> {
        const candidate = await manager
            .createQueryBuilder(StrategyVersionEntity, 'sv')
            .setLock('pessimistic_write')
            .where('sv.id = :id', { id: versionId })
            .getOne();

        if (candidate === null) {
            throw new PromotionStateException(`PromotionService: candidate version ${versionId} not found`);
        }

        if (candidate.status !== StrategyStatusEnum.DRAFT) {
            throw new PromotionStateException(`PromotionService: candidate version ${versionId} must be draft (was ${candidate.status})`);
        }

        return candidate;
    }

    private async lockArchivedForReactivate(manager: EntityManager, versionId: number): Promise<StrategyVersionEntity> {
        const target = await manager
            .createQueryBuilder(StrategyVersionEntity, 'sv')
            .setLock('pessimistic_write')
            .where('sv.id = :id', { id: versionId })
            .getOne();

        if (target === null) {
            throw new PromotionStateException(`PromotionService: version ${versionId} not found`);
        }

        if (target.status !== StrategyStatusEnum.ARCHIVED) {
            throw new PromotionStateException(`PromotionService: version ${versionId} must be archived to reactivate (was ${target.status})`);
        }

        return target;
    }

    private async lockActiveByName(manager: EntityManager, name: string, excludingId: number): Promise<StrategyVersionEntity | null> {
        return manager
            .createQueryBuilder(StrategyVersionEntity, 'sv')
            .setLock('pessimistic_write')
            .where('sv.name = :name', { name })
            .andWhere('sv.status = :status', { status: StrategyStatusEnum.ACTIVE })
            .andWhere('sv.id <> :excludingId', { excludingId })
            .getOne();
    }

    private async requireReportRow(manager: EntityManager, reportId: number): Promise<ComparisonReportEntity> {
        const report = await manager.findOne(ComparisonReportEntity, { where: { id: reportId } });

        if (report === null) {
            throw new PromotionStateException(`PromotionService: comparison report ${reportId} not found`);
        }

        return report;
    }

    // ADR 0016 §2.2 step 2: the report must explicitly promote THIS version. The gate
    // (PromotionGateService) re-evaluates against the live baseline at promote time, but a
    // green gate alone is not enough — the report row referenced by the operator must also
    // carry a `decision === 'promote'` for `versionId`. Two paranoid checks here:
    //   (a) the report's version_ids array contains versionId — guards against
    //       cross-version mismatches when the operator passes an unrelated reportId.
    //   (b) the artefact JSON's promotionDecisions[versionId].decision === 'promote' —
    //       guards against approving a candidate whose comparison report concluded
    //       'inconclusive' or 'reject' for it.
    // The artefact load is the same shape PromotionGateService consumes; we accept both
    // the Map-tuple form and a plain object keyed by versionId stringified, mirroring the
    // gate's hydrator.
    private async requireReportPromotesVersion(reportRow: ComparisonReportEntity, versionId: number): Promise<void> {
        if (!reportRow.versionIds.includes(versionId)) {
            throw new PromotionStateException(`PromotionService: comparison report ${reportRow.id} does not include version ${versionId} (versionIds=[${reportRow.versionIds.join(',')}])`);
        }

        const decision = await this.readPromotionDecision(reportRow, versionId);

        if (decision !== 'promote') {
            throw new PromotionStateException(`PromotionService: comparison report ${reportRow.id} does not promote version ${versionId} (decision=${decision ?? 'missing'})`);
        }
    }

    private async readPromotionDecision(reportRow: ComparisonReportEntity, versionId: number): Promise<string | null> {
        // R2-M-followup: defense-in-depth path containment. PromotionGateService.evaluate()
        // already rejected a tampered artefact_uri before the TX began, but loading the
        // artefact a second time here without the same guard would silently trust the DB row.
        // Mirror the gate's check so both readers share the contract.
        const resolved = resolvePath(reportRow.artefactUri);
        const rel = relativePath(BACKTEST_ARTEFACT_ROOT, resolved);

        if (rel.startsWith('..') || resolvePath(BACKTEST_ARTEFACT_ROOT, rel) !== resolved) {
            throw new ArtefactPathOutsideRootException(
                `comparison_reports.artefact_uri='${reportRow.artefactUri}' resolves outside BACKTEST_ARTEFACT_ROOT='${BACKTEST_ARTEFACT_ROOT}'`,
            );
        }

        const raw = await fs.readFile(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const decisions = parsed['promotionDecisions'];

        if (decisions === null || decisions === undefined) {
            return null;
        }

        if (Array.isArray(decisions)) {
            for (const entry of decisions as Array<[unknown, unknown]>) {
                if (Number(entry[0]) === versionId) {
                    return extractDecision(entry[1]);
                }
            }
            return null;
        }

        if (typeof decisions === 'object') {
            const record = (decisions as Record<string, unknown>)[String(versionId)];
            return extractDecision(record);
        }

        return null;
    }
}

// Recognise a concurrent-promotion race. Two distinct PG error classes can
// surface depending on timing:
//   1. SQLSTATE 23505 (unique_violation) against the
//      `uq_strategy_versions_active_per_name` partial unique index — the
//      loser reached the index check.
//   2. SQLSTATE 40001 (serialization_failure) — under SERIALIZABLE isolation
//      Postgres' SSI aborted one TX before it reached the index check because
//      it detected a read/write dependency cycle (both TXs read "no active
//      row for name" then both wrote one).
// We gate the unique-violation arm on the constraint name so any other unique
// index someone adds later does NOT get re-thrown as a promotion conflict; the
// serialization-failure arm is naturally scoped because this service is the
// only SERIALIZABLE TX touching `strategy_versions`.
function isActivePerNameUniqueViolation(cause: unknown): boolean {
    if (!(cause instanceof QueryFailedError)) {
        return false;
    }

    const driverError = (cause as QueryFailedError & { driverError?: { code?: string; constraint?: string } }).driverError;
    const code = driverError?.code;
    const constraint = driverError?.constraint;

    if (code === PG_UNIQUE_VIOLATION_CODE && constraint === ACTIVE_PER_NAME_CONSTRAINT) {
        return true;
    }

    // Belt-and-braces — some pg driver paths surface the constraint name only in
    // the message string. Match it there as a fallback so the catch is robust
    // across pg versions / connection adapters.
    if (code === PG_UNIQUE_VIOLATION_CODE && cause.message.includes(ACTIVE_PER_NAME_CONSTRAINT)) {
        return true;
    }

    if (code === PG_SERIALIZATION_FAILURE_CODE) {
        return true;
    }

    return false;
}

function extractDecision(value: unknown): string | null {
    if (value === null || value === undefined || typeof value !== 'object') {
        return null;
    }

    const decision = (value as Record<string, unknown>)['decision'];

    return typeof decision === 'string' ? decision : null;
}
