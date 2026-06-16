// M37 W1 (D1.2) — active-vs-shadow source-precedence resolver.
//
// The same `strategy_versions` row can have data in BOTH `decisions`/`positions`
// (when it was/is the active version) AND `shadow_decisions` (when it was/is
// shadow-evaluated concurrently). v2 (id=3) is the canonical case: it is active
// since Jun 8 AND has shadow_decisions rows through Jun 14. Reading both streams
// for it would double-count.
//
// The HARD precedence rule (M37 §W1 D1.2, ADR 0029 §2.1): a version whose
// CURRENT `strategy_versions.status = 'active'` is read from the active stream
// (`decisions`/`positions`); EVERY other status (shadow/draft/archived) is read
// from the shadow stream (`shadow_decisions`). The current status is the single
// source of truth — a version is never read from both streams.
//
// Boundary invariant (ADR 0033 §2.2): no @bot/engine, no @bot/shared value
// imports — pure local infra. The status string is compared against the literal
// 'active' (the @bot/shared StrategyStatusEnum.ACTIVE value) rather than
// importing the enum, because the analysis Jest moduleNameMapper resolves
// @bot/shared value-imports to source artifacts that fail to load under ts-jest
// (see the note in getPerformance.formatMoneyString).

import { DataSource } from 'typeorm';

import { AnalysisValidationError } from './analysisValidation.js';

// Mirrors StrategyStatusEnum.ACTIVE. The active version is the ONLY status read
// from the live `decisions`/`positions` stream; all others read shadow.
const ACTIVE_STATUS = 'active';

export type VersionSource = 'active' | 'shadow';

interface IVersionStatusRow {
    readonly label: string;
    readonly status: string;
}

export interface IResolvedVersion {
    readonly versionId: number;
    readonly label: string;
    readonly status: string;
    readonly source: VersionSource;
}

const VERSION_STATUS_SQL = `
    SELECT
        sv.name || '@v' || sv.version::text AS label,
        sv.status                            AS status
    FROM strategy_versions sv
    WHERE sv.strategy_versions_id = $1
    LIMIT 1
`;

// Resolves the read-source for a version by its CURRENT status. Throws when the
// version does not exist so callers surface a canonical "no such version" rather
// than silently reading an empty stream.
export async function resolveVersionSource(ds: DataSource, versionId: number): Promise<IResolvedVersion> {
    const rows: IVersionStatusRow[] = await ds.query(VERSION_STATUS_SQL, [versionId]);
    const found = rows[0];

    if (found === undefined) {
        throw new AnalysisValidationError('versionId', `no such version: ${versionId}`);
    }

    return {
        versionId,
        label: found.label,
        status: found.status,
        source: toVersionSource(found.status),
    };
}

function toVersionSource(status: string): VersionSource {
    return status === ACTIVE_STATUS ? 'active' : 'shadow';
}
