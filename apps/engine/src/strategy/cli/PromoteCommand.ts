import { Logger } from '@nestjs/common';

import { PromotionRejectedException } from '../../promotion/exception/PromotionRejectedException';
import { IPromotionGateOutcome } from '../../promotion/interface/IPromotionGateOutcome';
import { PromotionService } from '../../promotion/service/PromotionService';
import { StrategyVersionEntity } from '../entity/StrategyVersionEntity';
import { parseFlagMap, requireFlag } from './cliArgs';

// `strategy promote` (ADR 0019 §2.5 step 4). Thin CLI wrapper over PromotionService.promote
// that translates a PromotionRejectedException into a structured rejection table for the
// operator. No `--force` flag (ADR 0019 §2.1).

export interface IPromoteArgs {
    readonly versionId: number;
    readonly reportId: number;
    readonly note: string;
}

export type IPromoteCommandResult = ISuccessResult | IRejectionResult;

interface ISuccessResult {
    readonly success: true;
    readonly summary: string;
}

interface IRejectionResult {
    readonly success: false;
    readonly rejectionTable: string;
}

export class PromoteCommand {
    private readonly logger = new Logger(PromoteCommand.name);

    constructor(private readonly promotionService: PromotionService) {}

    async execute(args: IPromoteArgs): Promise<IPromoteCommandResult> {
        try {
            const promoted = await this.promotionService.promote(args.versionId, args.reportId, args.note);

            this.logger.log(`promote ok versionId=${args.versionId} reportId=${args.reportId}`);

            return { success: true, summary: renderPromotedRow(promoted) };
        } catch (cause) {
            if (cause instanceof PromotionRejectedException) {
                this.logger.warn(`promote rejected versionId=${args.versionId} reportId=${args.reportId} decision=${cause.outcome.decision}`);

                return { success: false, rejectionTable: renderRejectionTable(cause.outcome) };
            }

            throw cause;
        }
    }
}

// --- Argument parsing --------------------------------------------------------

export function parsePromoteArgs(argv: readonly string[]): IPromoteArgs {
    const flags = parseFlagMap(argv);

    const versionIdRaw = requireFlag(flags, 'version-id');
    const reportIdRaw = requireFlag(flags, 'report-id');
    const note = requireFlag(flags, 'note');

    const versionId = Number(versionIdRaw);
    const reportId = Number(reportIdRaw);

    if (!Number.isInteger(versionId) || versionId <= 0) {
        throw new Error(`--version-id '${versionIdRaw}' must be a positive integer`);
    }

    if (!Number.isInteger(reportId) || reportId <= 0) {
        throw new Error(`--report-id '${reportIdRaw}' must be a positive integer`);
    }

    if (note.length === 0) {
        throw new Error('--note must be non-empty');
    }

    return { versionId, reportId, note };
}

// --- Renderers ---------------------------------------------------------------

function renderPromotedRow(row: StrategyVersionEntity): string {
    return [
        'Promotion succeeded.',
        `  id:                ${row.id}`,
        `  name:version:      ${row.name}:${row.version}`,
        `  status:            ${row.status}`,
        `  direction:         ${row.direction}`,
        `  promotedAt:        ${row.promotedAt?.toISOString() ?? 'null'}`,
        `  promotionReportId: ${row.promotionReportId ?? 'null'}`,
        `  promotionNote:     ${row.promotionNote ?? ''}`,
    ].join('\n');
}

function renderRejectionTable(outcome: IPromotionGateOutcome): string {
    const header = '| # | criterion                       | severity     | threshold                                                | observed                                                 |';
    const sep = '|---|---------------------------------|--------------|----------------------------------------------------------|----------------------------------------------------------|';
    const rows: string[] = [
        `Promotion rejected. versionId=${outcome.versionId} reportId=${outcome.reportId} decision=${outcome.decision}`,
        `Passed criteria: ${outcome.passedCriteria.join(', ') || '(none)'}`,
        outcome.inconclusiveReason !== undefined ? `Inconclusive reason: ${outcome.inconclusiveReason}` : '',
        '',
        header,
        sep,
    ].filter((line) => line !== '');

    for (const failure of outcome.failedCriteria) {
        rows.push(`| ${pad(String(failure.index), 1)} | ${pad(failure.name, 31)} | ${pad(failure.severity, 12)} | ${pad(failure.threshold, 56)} | ${pad(failure.observed, 56)} |`);
    }

    return rows.join('\n');
}

function pad(value: string, width: number): string {
    if (value.length >= width) {
        return value;
    }

    return value + ' '.repeat(width - value.length);
}
