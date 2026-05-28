// M13 W3 — write one row per weekly agent run into `agent_run_history`.
//
// M13 W6 fix wave 2 (#1): the `agent_writer` role is created with
// `default_transaction_read_only = on`, which makes a direct `INSERT …
// RETURNING` issued by the agent fail with SQLSTATE 25006
// (`read_only_sql_transaction`). The write path is now the SECURITY DEFINER
// function `record_agent_run_history` (migration `20260620000002`); the
// function flips read-only off via `SET LOCAL` inside its body and runs as
// its OWNER (the migration role), where the role-default does not apply.
// The previous column-level INSERT grant on the table has been REVOKEd in
// the same migration so the SDF is the sole write path.
//
// The UNIQUE constraint on `week_iso` (combined with the SDF's
// `ON CONFLICT DO NOTHING`) keeps the call idempotent: a re-fired cron in
// the same ISO week resolves to NULL. The caller treats NULL as "history
// already recorded" and does not raise.

import { TerminalStateEnum } from '@bot/shared';

import type { IAgentPgClient } from './AgentPgClient.js';

export interface IAgentRunHistoryRow {
    readonly weekIso: string;
    readonly parentVersionId: number;
    readonly draftVersionId: number | null;
    readonly modelId: string;
    readonly reportMdPath: string | null;
    readonly reportJsonPath: string | null;
    readonly terminalState: TerminalStateEnum;
    readonly failureReason: string | null;
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
    readonly bootstrapCiLo: string | null;
    readonly bootstrapCiHi: string | null;
    readonly passesPromotionGate: boolean | null;
}

interface ISdfRow {
    readonly agent_run_id: number | string | null;
}

export async function insertAgentRunHistory(pg: IAgentPgClient, row: IAgentRunHistoryRow): Promise<number | null> {
    const rows = await pg.query<ISdfRow>(
        `SELECT record_agent_run_history(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        ) AS agent_run_id`,
        [
            row.weekIso,
            row.parentVersionId,
            row.draftVersionId,
            row.modelId,
            row.reportMdPath,
            row.reportJsonPath,
            row.terminalState,
            row.failureReason,
            row.startedAt,
            row.finishedAt,
            row.bootstrapCiLo,
            row.bootstrapCiHi,
            row.passesPromotionGate,
        ],
    );

    if (rows.length === 0) {
        return null;
    }

    const id = rows[0].agent_run_id;
    if (id === null || id === undefined) {
        return null;
    }
    return typeof id === 'string' ? Number(id) : id;
}
