import { Logger } from '@nestjs/common';

import { PromotionService } from '../../promotion/service/PromotionService';
import { StrategyVersionEntity } from '../entity/StrategyVersionEntity';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { parseFlagMap, requireFlag } from './cliArgs';

// `strategy reactivate` (ADR 0019 §2.1). Reactivation is the symmetric inverse of
// promotion: archive any current active row for the same name and flip the target archived
// row back to active. The gate is NOT evaluated — by design, reactivation is an
// operator-controlled rollback to a known-good prior version, not a new approval.

export interface IReactivateArgs {
    readonly versionId: number;
}

export interface IReactivateCommandResult {
    readonly summary: string;
}

export class ReactivateCommand {
    private readonly logger = new Logger(ReactivateCommand.name);

    constructor(
        private readonly promotionService: PromotionService,
        private readonly strategyVersionRepository: StrategyVersionRepository,
    ) {}

    async execute(args: IReactivateArgs): Promise<IReactivateCommandResult> {
        const before = await this.strategyVersionRepository.findById(args.versionId);

        if (before === null) {
            throw new Error(`reactivate: strategy version id=${args.versionId} not found`);
        }

        const after = await this.promotionService.reactivate(args.versionId);

        this.logger.log(`reactivate ok versionId=${args.versionId} name=${after.name}`);

        return { summary: renderBeforeAfter(before, after) };
    }
}

// --- Argument parsing --------------------------------------------------------

export function parseReactivateArgs(argv: readonly string[]): IReactivateArgs {
    const flags = parseFlagMap(argv);
    const versionIdRaw = requireFlag(flags, 'version-id');
    const versionId = Number(versionIdRaw);

    if (!Number.isInteger(versionId) || versionId <= 0) {
        throw new Error(`--version-id '${versionIdRaw}' must be a positive integer`);
    }

    return { versionId };
}

// --- Renderer ----------------------------------------------------------------

function renderBeforeAfter(before: StrategyVersionEntity, after: StrategyVersionEntity): string {
    return [
        'Reactivation succeeded.',
        `  id:                ${after.id}`,
        `  name:version:      ${after.name}:${after.version}`,
        `  status:            ${before.status} -> ${after.status}`,
        `  archivedAt:        ${before.archivedAt?.toISOString() ?? 'null'} -> ${after.archivedAt?.toISOString() ?? 'null'}`,
        `  promotedAt:        ${before.promotedAt?.toISOString() ?? 'null'} -> ${after.promotedAt?.toISOString() ?? 'null'}`,
    ].join('\n');
}
