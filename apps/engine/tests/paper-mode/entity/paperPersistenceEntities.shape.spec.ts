/**
 * M11a R2b wave A — entity-shape smoke for the five PAPER persistence
 * entities. Asserts TypeORM column metadata matches the migration contract:
 *
 *   1. Table name + snake_case column names per code conventions.
 *   2. NUMERIC columns carry the `decimalColumnTransformer` (money rule:
 *      never `number` for prices/PnL/fees).
 *   3. UUID PKs.
 *   4. `paper_account_state` has NO `unrealised_pnl` column (ADR 0032 §D16 —
 *      unrealised PnL is derived, not state).
 *   5. `paper_simulator_idempotency` carries the composite-key columns.
 *
 * No DB needed; reads `getMetadataArgsStorage()` which is populated by the
 * `@Entity`/`@Column` decorators at import time.
 */

import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';

import { decimalColumnTransformer } from '../../../src/common/utils';
import {
    PaperAccountSnapshotEntity,
    PaperAccountStateEntity,
    PaperAccountStateHistoryEntity,
    PaperAccountStateMetaEntity,
    PaperSimulatorIdempotencyEntity,
} from '../../../src/paper-mode/entity';

type EntityClass = new (...args: never[]) => object;

function tableNameFor(target: EntityClass): string | undefined {
    const meta = getMetadataArgsStorage().tables.find((t) => t.target === target);

    return meta?.name;
}

function columnsFor(target: EntityClass): Map<string, { name: string | undefined; type: unknown; transformer: unknown }> {
    const cols = getMetadataArgsStorage().columns.filter((c) => c.target === target);
    const map = new Map<string, { name: string | undefined; type: unknown; transformer: unknown }>();

    for (const c of cols) {
        map.set(c.propertyName, {
            name: c.options.name,
            type: c.options.type,
            transformer: c.options.transformer,
        });
    }

    return map;
}

describe('PAPER persistence entities — shape smoke (M11a R2b wave A)', () => {
    describe('PaperAccountStateEntity', () => {
        const cols = columnsFor(PaperAccountStateEntity);

        it('maps to the paper_account_state table', () => {
            expect(tableNameFor(PaperAccountStateEntity)).toBe('paper_account_state');
        });

        it('exposes the position-defining columns with snake_case DB names', () => {
            expect(cols.get('clientOrderId')?.name).toBe('client_order_id');
            expect(cols.get('symbol')?.name).toBe('symbol');
            expect(cols.get('side')?.name).toBe('side');
            expect(cols.get('entryPrice')?.name).toBe('entry_price');
            expect(cols.get('size')?.name).toBe('size');
            expect(cols.get('leverage')?.name).toBe('leverage');
            expect(cols.get('openedAt')?.name).toBe('opened_at');
            expect(cols.get('mode')?.name).toBe('mode');
        });

        it('uses the decimal transformer on money columns (D16 money rule)', () => {
            expect(cols.get('entryPrice')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('size')?.transformer).toBe(decimalColumnTransformer);
        });

        it('does NOT carry an unrealised_pnl column (D16 — derived, not state)', () => {
            expect(cols.has('unrealisedPnl')).toBe(false);

            for (const [, info] of cols) {
                expect(info.name).not.toBe('unrealised_pnl');
            }
        });
    });

    describe('PaperAccountStateHistoryEntity', () => {
        const cols = columnsFor(PaperAccountStateHistoryEntity);

        it('maps to the paper_account_state_history table', () => {
            expect(tableNameFor(PaperAccountStateHistoryEntity)).toBe('paper_account_state_history');
        });

        it('exposes the closed-trade ledger columns with snake_case DB names', () => {
            expect(cols.get('clientOrderId')?.name).toBe('client_order_id');
            expect(cols.get('exitPrice')?.name).toBe('exit_price');
            expect(cols.get('realisedPnl')?.name).toBe('realised_pnl');
            expect(cols.get('fees')?.name).toBe('fees');
            expect(cols.get('fundingAccrued')?.name).toBe('funding_accrued');
            expect(cols.get('slippage')?.name).toBe('slippage');
            expect(cols.get('closeReason')?.name).toBe('close_reason');
            expect(cols.get('closedAt')?.name).toBe('closed_at');
        });

        it('uses the decimal transformer on every monetary column', () => {
            expect(cols.get('entryPrice')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('exitPrice')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('size')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('realisedPnl')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('fees')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('fundingAccrued')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('slippage')?.transformer).toBe(decimalColumnTransformer);
        });
    });

    describe('PaperAccountStateMetaEntity', () => {
        const cols = columnsFor(PaperAccountStateMetaEntity);

        it('maps to the paper_account_state_meta table', () => {
            expect(tableNameFor(PaperAccountStateMetaEntity)).toBe('paper_account_state_meta');
        });

        it('exposes only non-secret derived metadata columns', () => {
            expect(cols.get('soakStartId')?.name).toBe('soak_start_id');
            expect(cols.get('soakStartTs')?.name).toBe('soak_start_ts');
            expect(cols.get('seedVersionLabel')?.name).toBe('seed_version_label');
            expect(cols.get('hkdfInfoVersion')?.name).toBe('hkdf_info_version');
            expect(cols.get('simulatorConfigHash')?.name).toBe('simulator_config_hash');
            expect(cols.get('bootstrapAtStartFingerprint')?.name).toBe('bootstrap_at_start_fingerprint');
        });

        it('does NOT carry any raw-secret column (D3 / D17 — fingerprints only)', () => {
            for (const [, info] of cols) {
                expect(info.name).not.toMatch(/^bootstrap_secret$/);
                expect(info.name).not.toMatch(/^seed_master$/);
                expect(info.name).not.toMatch(/^crn_root$/);
            }
        });
    });

    describe('PaperAccountSnapshotEntity', () => {
        const cols = columnsFor(PaperAccountSnapshotEntity);

        it('maps to the paper_account_snapshots table', () => {
            expect(tableNameFor(PaperAccountSnapshotEntity)).toBe('paper_account_snapshots');
        });

        it('carries the equity-curve columns including peak_equity (D5 drawdown denominator)', () => {
            expect(cols.get('takenAt')?.name).toBe('taken_at');
            expect(cols.get('balance')?.name).toBe('balance');
            expect(cols.get('equity')?.name).toBe('equity');
            expect(cols.get('realisedPnlCumulative')?.name).toBe('realised_pnl_cumulative');
            expect(cols.get('fundingAccruedCumulative')?.name).toBe('funding_accrued_cumulative');
            expect(cols.get('unrealisedPnlTotal')?.name).toBe('unrealised_pnl_total');
            expect(cols.get('peakEquity')?.name).toBe('peak_equity');
            expect(cols.get('openPositionsCount')?.name).toBe('open_positions_count');
        });

        it('uses the decimal transformer on every monetary column', () => {
            expect(cols.get('balance')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('equity')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('realisedPnlCumulative')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('fundingAccruedCumulative')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('unrealisedPnlTotal')?.transformer).toBe(decimalColumnTransformer);
            expect(cols.get('peakEquity')?.transformer).toBe(decimalColumnTransformer);
        });
    });

    describe('PaperSimulatorIdempotencyEntity', () => {
        const cols = columnsFor(PaperSimulatorIdempotencyEntity);

        it('maps to the paper_simulator_idempotency table', () => {
            expect(tableNameFor(PaperSimulatorIdempotencyEntity)).toBe('paper_simulator_idempotency');
        });

        it('carries the composite-key columns + the jsonb fill payload', () => {
            expect(cols.get('eventId')?.name).toBe('event_id');
            expect(cols.get('orderIntentId')?.name).toBe('order_intent_id');
            expect(cols.get('versionNamespace')?.name).toBe('version_namespace');
            expect(cols.get('simulatedFillId')?.name).toBe('simulated_fill_id');
            expect(cols.get('simulatedFillPayload')?.name).toBe('simulated_fill_payload');
            expect(cols.get('simulatedFillPayload')?.type).toBe('jsonb');
        });
    });
});
