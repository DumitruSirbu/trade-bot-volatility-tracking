// M13 W1.C — `selectHaltState` query function.
//
// Reads the most recent `risk_state` row and maps it to the shared
// `IHaltStateView`. `risk_state` is keyed UNIQUE on `date` (one row per UTC
// day, see migration 20260522010000-CreateSchema). "Most recent" therefore
// means ORDER BY date DESC LIMIT 1. The table has no `updated_at` column
// today (a pre-M15 deferred item adds a true newer-wins timestamp); until
// then `asOf` reports the row's `date` rendered at UTC midnight, which is
// the latest authoritative timestamp available on this table.
//
// When the table is empty (no risk-day rows yet — fresh DB), the query
// FAILS CLOSED: returns `{ isHalted: true, haltReason: 'NO_RISK_STATE_ROW' }`.
// Trade-safety invariant: a missing risk-state row means the engine has
// not yet established a known-safe baseline, and the agent must NOT draft
// against an undefined state. The agent's halt-aware boot translates this
// into `terminal_state='SKIPPED_HALTED'`.
//
// SQL is parameterized; no caller-supplied bindings are needed. The row
// shape is narrowed defensively to surface schema drift as a thrown error
// at the read layer rather than a silent NaN downstream.
//
// Boundary invariant (ADR 0033 §2.2): depends on `@bot/shared` + `typeorm`
// only — no `@bot/engine` reaches.

import { DataSource } from 'typeorm';
import type { IHaltStateView } from '@bot/shared';

interface IRiskStateRow {
    readonly is_halted: boolean;
    readonly halt_reason: string | null;
    // pg `date` is returned as a `Date` (midnight UTC) by node-postgres when
    // the typed-row branch is in use. Accept either a Date or an ISO string
    // (some DataSource adapters stringify dates).
    readonly date: Date | string;
}

export async function selectHaltState(ds: DataSource): Promise<IHaltStateView> {
    const sql = `
        SELECT
            r.is_halted    AS is_halted,
            r.halt_reason  AS halt_reason,
            r.date         AS date
        FROM risk_state r
        ORDER BY r.date DESC
        LIMIT 1
    `;

    const rows: unknown[] = await ds.query(sql);

    if (rows.length === 0) {
        // Fail-closed: an empty risk_state table means no authoritative
        // baseline exists — surface as halted so the agent skips with
        // SKIPPED_HALTED rather than drafting against an unknown state.
        return {
            isHalted: true,
            haltReason: 'NO_RISK_STATE_ROW',
            asOf: new Date().toISOString(),
        };
    }

    return mapRow(narrowRow(rows[0]));
}

function narrowRow(raw: unknown): IRiskStateRow {
    if (raw === null || typeof raw !== 'object') {
        throw new Error('selectHaltState: row is not an object');
    }

    const row = raw as Record<string, unknown>;
    if (typeof row['is_halted'] !== 'boolean') {
        throw new Error('selectHaltState: is_halted is not a boolean');
    }

    const haltReason = row['halt_reason'];
    if (haltReason !== null && typeof haltReason !== 'string') {
        throw new Error('selectHaltState: halt_reason is neither string nor null');
    }

    const date = row['date'];
    if (!(date instanceof Date) && typeof date !== 'string') {
        throw new Error('selectHaltState: date is neither Date nor string');
    }

    return { is_halted: row['is_halted'], halt_reason: haltReason, date };
}

function mapRow(row: IRiskStateRow): IHaltStateView {
    const asOf = row.date instanceof Date ? row.date.toISOString() : new Date(row.date).toISOString();

    return {
        isHalted: row.is_halted,
        haltReason: row.halt_reason,
        asOf,
    };
}
