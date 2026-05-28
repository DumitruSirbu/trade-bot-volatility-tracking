// M13 W3 — calls the `draft_strategy_version` SECURITY DEFINER function
// (ADR 0036 §2.3) via the agent's pg client. The SDF returns NULL when
// `(parent_version_id, week_iso)` is already drafted in the current ISO week
// (idempotency contract — re-fired cron is a silent no-op). Callers map
// NULL to `terminal_state='IDEMPOTENT_SKIP'`.

import type { IAgentPgClient } from './AgentPgClient.js';

export interface IDraftStrategyVersionArgs {
    readonly parentVersionId: number;
    readonly params: Record<string, unknown>;
    readonly rationale: string;
    readonly weekIso: string;
}

interface ISdfRow {
    readonly strategy_versions_id: number | null;
}

export async function draftStrategyVersion(
    pg: IAgentPgClient,
    args: IDraftStrategyVersionArgs,
): Promise<number | null> {
    const rows = await pg.query<ISdfRow>(
        `SELECT draft_strategy_version($1, $2::jsonb, $3, $4) AS strategy_versions_id`,
        [args.parentVersionId, JSON.stringify(args.params), args.rationale, args.weekIso],
    );

    if (rows.length === 0) {
        return null;
    }

    const id = rows[0].strategy_versions_id;
    return id === null || id === undefined ? null : id;
}
