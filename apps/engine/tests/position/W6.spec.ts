/**
 * M6 W6 — PositionInstrumentor (ADR 0013).
 *
 * Coverage matrix:
 *   - Pure metric updaters (instrumentationMath.ts):
 *     - computeExcursionPct: LONG positive when mark>entry, SHORT positive when entry>mark; zero entry safe.
 *     - updateMaePct: monotone non-positive; favorable ticks no-op.
 *     - updateMfePct: monotone non-negative; adverse ticks no-op.
 *     - updateTimeToReversionSecs: first-cross-only; direction-symmetric.
 *     - computeStopGapPct: side-aware; null SL safe.
 *     - updateMarkVsLastMaxDivergencePct: non-negative, monotone.
 *     - updateMinLiquidationDistancePct: monotone min; null liq tolerated.
 *   - Service:
 *     - onPositionOpened seeds accumulator from persisted row (recovery floor).
 *     - onPriceUpdate samples tracked positions, ignores non-tracked symbols, accrues MAE/MFE.
 *     - flushPending writes ONE update per dirty position; clean states skipped.
 *     - N synthetic ticks within a flush window → 1 UPDATE (write-amplification rule).
 *     - onPositionStateTransitioned(CLOSED) flushes synchronously + drops state.
 *     - onPositionStateTransitioned(RECONCILING / MANUAL_ADOPTED_UNMANAGED) drops state without flush.
 *     - stop_gap_pct written only on STOP_LOSS exit; null for other exit reasons.
 *     - getLifeStats returns in-memory snapshot; null for non-tracked.
 */

import { ExitReasonEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../src/common/utils/money';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';
import {
    computeExcursionPct,
    computeStopGapPct,
    updateMaePct,
    updateMarkVsLastMaxDivergencePct,
    updateMfePct,
    updateMinLiquidationDistancePct,
    updateTimeToReversionSecs,
} from '../../src/position/util/instrumentationMath';

// ─── pure updaters ─────────────────────────────────────────────────────────

describe('instrumentationMath.computeExcursionPct (ADR 0013 §1 intro)', () => {
    it('LONG with mark above entry returns positive excursion', () => {
        const result = computeExcursionPct(PositionSideEnum.LONG, new Money('30000'), new Money('30300'));

        expect(result.toFixed()).toBe('0.01'); // 1%
    });

    it('LONG with mark below entry returns negative excursion', () => {
        const result = computeExcursionPct(PositionSideEnum.LONG, new Money('30000'), new Money('29700'));

        expect(result.toFixed()).toBe('-0.01');
    });

    it('SHORT with mark below entry returns positive excursion (mirror of LONG)', () => {
        const result = computeExcursionPct(PositionSideEnum.SHORT, new Money('30000'), new Money('29700'));

        expect(result.toFixed()).toBe('0.01');
    });

    it('SHORT with mark above entry returns negative excursion', () => {
        const result = computeExcursionPct(PositionSideEnum.SHORT, new Money('30000'), new Money('30300'));

        expect(result.toFixed()).toBe('-0.01');
    });

    it('zero entry price returns zero (defensive — should never happen in production)', () => {
        const result = computeExcursionPct(PositionSideEnum.LONG, new Money('0'), new Money('100'));

        expect(result.toFixed()).toBe('0');
    });
});

describe('instrumentationMath.updateMaePct (ADR 0013 §1a)', () => {
    it('initial MAE is the first adverse excursion', () => {
        const result = updateMaePct(null, new Money('-0.02'));

        expect(result.toFixed()).toBe('-0.02');
    });

    it('favorable excursion does not change a null prior MAE (stays 0)', () => {
        const result = updateMaePct(null, new Money('0.03'));

        expect(result.toFixed()).toBe('0');
    });

    it('updates to the deeper (more negative) excursion (monotone min)', () => {
        const result = updateMaePct(new Money('-0.01'), new Money('-0.025'));

        expect(result.toFixed()).toBe('-0.025');
    });

    it('does not update when the new excursion is less adverse', () => {
        const result = updateMaePct(new Money('-0.025'), new Money('-0.01'));

        expect(result.toFixed()).toBe('-0.025');
    });

    it('favorable excursion never overwrites an existing adverse MAE', () => {
        const result = updateMaePct(new Money('-0.02'), new Money('0.05'));

        expect(result.toFixed()).toBe('-0.02');
    });

    it('reviewer rule §1a: mae_pct is non-positive at all times', () => {
        // Synthetic sequence of mixed-sign excursions; MAE must end non-positive.
        let mae: MoneyValue | null = null;
        const excursions = ['-0.01', '0.02', '-0.005', '0.04', '-0.03', '0.01'];

        for (const e of excursions) {
            mae = updateMaePct(mae, new Money(e));
        }

        expect(mae!.lessThanOrEqualTo(0)).toBe(true);
    });
});

describe('instrumentationMath.updateMfePct (ADR 0013 §1b)', () => {
    it('initial MFE is the first favorable excursion', () => {
        const result = updateMfePct(null, new Money('0.02'));

        expect(result.toFixed()).toBe('0.02');
    });

    it('adverse excursion does not change a null prior MFE (stays 0)', () => {
        const result = updateMfePct(null, new Money('-0.03'));

        expect(result.toFixed()).toBe('0');
    });

    it('updates to the higher excursion (monotone max)', () => {
        const result = updateMfePct(new Money('0.01'), new Money('0.025'));

        expect(result.toFixed()).toBe('0.025');
    });

    it('does not update when the new excursion is lower', () => {
        const result = updateMfePct(new Money('0.025'), new Money('0.01'));

        expect(result.toFixed()).toBe('0.025');
    });

    it('reviewer rule §1b: mfe_pct is non-negative at all times', () => {
        let mfe: MoneyValue | null = null;

        for (const e of ['0.01', '-0.02', '0.005', '-0.04', '0.03']) {
            mfe = updateMfePct(mfe, new Money(e));
        }

        expect(mfe!.greaterThanOrEqualTo(0)).toBe(true);
    });
});

describe('instrumentationMath.updateTimeToReversionSecs (ADR 0013 §1c)', () => {
    const OPENED_AT_MS = 1_700_000_000_000;

    it('LONG: returns elapsed secs when mark crosses back up through vwap_at_entry', () => {
        const result = updateTimeToReversionSecs(null, PositionSideEnum.LONG, new Money('30000'), new Money('30001'), OPENED_AT_MS, OPENED_AT_MS + 5_500);

        expect(result).toBe(5); // floor(5500 / 1000)
    });

    it('SHORT: returns elapsed secs when mark crosses back down through vwap_at_entry', () => {
        const result = updateTimeToReversionSecs(null, PositionSideEnum.SHORT, new Money('30000'), new Money('29999'), OPENED_AT_MS, OPENED_AT_MS + 12_000);

        expect(result).toBe(12);
    });

    it('returns null while the reversion condition is not yet met', () => {
        const result = updateTimeToReversionSecs(null, PositionSideEnum.LONG, new Money('30000'), new Money('29500'), OPENED_AT_MS, OPENED_AT_MS + 5_000);

        expect(result).toBeNull();
    });

    it('first-cross-only: once recorded, never updates again', () => {
        const result = updateTimeToReversionSecs(5, PositionSideEnum.LONG, new Money('30000'), new Money('30005'), OPENED_AT_MS, OPENED_AT_MS + 60_000);

        expect(result).toBe(5);
    });

    it('returns null when vwap_at_entry is null (instrument lacked VWAP)', () => {
        const result = updateTimeToReversionSecs(null, PositionSideEnum.LONG, null, new Money('30000'), OPENED_AT_MS, OPENED_AT_MS + 5_000);

        expect(result).toBeNull();
    });
});

describe('instrumentationMath.computeStopGapPct (ADR 0013 §1d)', () => {
    it('LONG: positive gap when fill is worse than SL (below)', () => {
        const result = computeStopGapPct(PositionSideEnum.LONG, new Money('29500'), new Money('29400'));

        expect(result!.toFixed(8)).toBe(new Money('100').dividedBy('29500').toFixed(8));
        expect(result!.greaterThan(0)).toBe(true);
    });

    it('SHORT: positive gap when fill is worse than SL (above)', () => {
        const result = computeStopGapPct(PositionSideEnum.SHORT, new Money('30500'), new Money('30600'));

        expect(result!.greaterThan(0)).toBe(true);
    });

    it('null SL returns null (defensive)', () => {
        const result = computeStopGapPct(PositionSideEnum.LONG, null, new Money('29400'));

        expect(result).toBeNull();
    });

    it('zero SL returns null (defensive)', () => {
        const result = computeStopGapPct(PositionSideEnum.LONG, new Money('0'), new Money('29400'));

        expect(result).toBeNull();
    });
});

describe('instrumentationMath.updateMarkVsLastMaxDivergencePct (ADR 0013 §1f)', () => {
    it('initial value is the first observed divergence', () => {
        const result = updateMarkVsLastMaxDivergencePct(null, new Money('30000'), new Money('30030'));

        expect(result.toFixed()).toBe('0.001'); // 30/30000
    });

    it('absolute value: returns positive on either ordering', () => {
        const result = updateMarkVsLastMaxDivergencePct(null, new Money('30000'), new Money('29970'));

        expect(result.toFixed()).toBe('0.001');
        expect(result.greaterThanOrEqualTo(0)).toBe(true);
    });

    it('monotone max: smaller divergence does not overwrite prior', () => {
        const result = updateMarkVsLastMaxDivergencePct(new Money('0.005'), new Money('30000'), new Money('30030'));

        expect(result.toFixed()).toBe('0.005');
    });
});

describe('instrumentationMath.updateMinLiquidationDistancePct (ADR 0013 §1g)', () => {
    it('LONG: distance is positive when mark is above liquidation', () => {
        const result = updateMinLiquidationDistancePct(null, PositionSideEnum.LONG, new Money('25000'), new Money('30000'));

        expect(result!.greaterThan(0)).toBe(true);
    });

    it('SHORT: distance is positive when liquidation is above mark', () => {
        const result = updateMinLiquidationDistancePct(null, PositionSideEnum.SHORT, new Money('35000'), new Money('30000'));

        expect(result!.greaterThan(0)).toBe(true);
    });

    it('monotone min: a closer-to-liq distance overwrites the prior', () => {
        const prior = new Money('0.20');
        const result = updateMinLiquidationDistancePct(prior, PositionSideEnum.LONG, new Money('29000'), new Money('30000'));

        expect(result!.lessThan(prior)).toBe(true);
    });

    it('null liquidation price returns the prior value unchanged (no liq known yet)', () => {
        const prior = new Money('0.15');
        const result = updateMinLiquidationDistancePct(prior, PositionSideEnum.LONG, null, new Money('30000'));

        expect(result).toBe(prior);
    });
});

// ─── service ──────────────────────────────────────────────────────────────

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(1_700_000_000_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        vwapAtEntry: null,
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        stopGapPct: null,
        stopLossPrice: new Money('29500'),
        ...overrides,
    } as PositionEntity;
}

function buildInstrumentorHarness(rowOnFind?: PositionEntity | null) {
    const findById = jest.fn().mockResolvedValue(rowOnFind ?? null);
    const save = jest.fn().mockImplementation(async (p: PositionEntity) => p);
    const positions = { findById, save } as unknown as PositionRepository;
    // M6 W8.5: gate-ready by default so existing W6 flushPending semantics are preserved;
    // the recovery-guard is exercised in tests/position/W8_5.spec.ts.
    const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as never;
    const instrumentor = new PositionInstrumentor(positions, riskGate);

    return { instrumentor, positions, findById, save };
}

describe('PositionInstrumentor — open / price.update / flush (ADR 0013 §2–§4)', () => {
    it('onPositionOpened seeds the accumulator from the persisted row (recovery floor, §5)', () => {
        const row = buildPositionRow({ maePct: new Money('-0.01'), mfePct: new Money('0.02') });
        const { instrumentor } = buildInstrumentorHarness(row);

        instrumentor.onPositionOpened(row);

        const stats = instrumentor.getLifeStats(42);
        expect(stats).not.toBeNull();
        expect(stats!.maePct!.toFixed()).toBe('-0.01');
        expect(stats!.mfePct!.toFixed()).toBe('0.02');
    });

    it('onPriceUpdate accrues MAE on adverse ticks (LONG, mark below entry)', () => {
        const row = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_001_000 });

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.maePct!.lessThan(0)).toBe(true);
        expect(stats.mfePct!.toFixed()).toBe('0');
    });

    it('onPriceUpdate accrues MFE on favorable ticks (LONG, mark above entry)', () => {
        const row = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '30600', timestampMs: 1_700_000_001_000 });

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.mfePct!.greaterThan(0)).toBe(true);
        expect(stats.maePct!.toFixed()).toBe('0');
    });

    it('onPriceUpdate ignores symbols with no tracked position (universe noise)', () => {
        const row = buildPositionRow({ symbol: 'BTCUSDT' });
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        // Tick for an unrelated symbol; tracked stats stay null/0.
        instrumentor.onPriceUpdate({ symbol: 'ETHUSDT', price: '2000', timestampMs: 1_700_000_001_000 });

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.maePct).toBeNull();
        expect(stats.mfePct).toBeNull();
    });

    it('flushPending writes ONE UPDATE per dirty position; clean positions skipped (§4 write-amp rule)', async () => {
        const row = buildPositionRow();
        const { instrumentor, save, findById } = buildInstrumentorHarness(row);
        findById.mockResolvedValue(row);
        instrumentor.onPositionOpened(row);

        // 10 synthetic adverse ticks within a single flush window — only the
        // single end-state should be persisted, not 10 separate writes.
        for (let i = 0; i < 10; i++) {
            instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: `2950${i % 10}`, timestampMs: 1_700_000_001_000 + i });
        }

        await instrumentor.flushPending();

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('flushPending no-ops when no positions are dirty (clean window)', async () => {
        const row = buildPositionRow();
        const { instrumentor, save } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        // No price ticks — accumulator is clean.
        await instrumentor.flushPending();

        expect(save).not.toHaveBeenCalled();
    });

    it('a second flush after no new ticks does not re-write (dirty flag cleared after flush)', async () => {
        const row = buildPositionRow();
        const { instrumentor, save, findById } = buildInstrumentorHarness(row);
        findById.mockResolvedValue(row);
        instrumentor.onPositionOpened(row);

        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_001_000 });
        await instrumentor.flushPending();
        await instrumentor.flushPending();

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('time_to_reversion_secs is recorded on first cross of vwap_at_entry (LONG)', () => {
        const row = buildPositionRow({
            side: PositionSideEnum.LONG,
            entryPrice: new Money('29800'),
            vwapAtEntry: new Money('30000'),
            openedAt: new Date(1_700_000_000_000),
        });
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        // Tick 1: below VWAP — not yet reverted.
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29900', timestampMs: 1_700_000_002_500 });
        expect(instrumentor.getLifeStats(42)!.timeToReversionSecs).toBeNull();

        // Tick 2: at/above VWAP — recorded.
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '30005', timestampMs: 1_700_000_007_500 });
        expect(instrumentor.getLifeStats(42)!.timeToReversionSecs).toBe(7);

        // Tick 3: another cross — must NOT update (first-cross-only).
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '30100', timestampMs: 1_700_000_020_000 });
        expect(instrumentor.getLifeStats(42)!.timeToReversionSecs).toBe(7);
    });

    it('min_liquidation_distance_pct decreases as mark approaches liquidation (LONG)', () => {
        const row = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);
        instrumentor.setLiquidationPrice(42, 'BTCUSDT', new Money('25000'));

        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '30000', timestampMs: 1_700_000_001_000 });
        const distAtEntry = instrumentor.getLifeStats(42)!.minLiquidationDistancePct;

        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '27000', timestampMs: 1_700_000_002_000 });
        const distAfterMove = instrumentor.getLifeStats(42)!.minLiquidationDistancePct;

        expect(distAtEntry!.greaterThan(0)).toBe(true);
        expect(distAfterMove!.lessThan(distAtEntry!)).toBe(true);
    });

    it('setLiquidationPrice on an untracked positionId is a safe no-op', () => {
        const { instrumentor } = buildInstrumentorHarness();

        expect(() => instrumentor.setLiquidationPrice(999, 'BTCUSDT', new Money('25000'))).not.toThrow();
    });
});

describe('PositionInstrumentor — state-transition hooks (ADR 0013 §1d, §2, §4)', () => {
    it('CLOSED transition with STOP_LOSS exit writes stop_gap_pct + flushes accumulator + drops state', async () => {
        const closedRow = buildPositionRow({
            state: PositionStateEnum.CLOSED,
            exitReason: ExitReasonEnum.STOP_LOSS,
            exitPrice: new Money('29400'),
            stopLossPrice: new Money('29500'),
            side: PositionSideEnum.LONG,
        });
        const { instrumentor, save, findById } = buildInstrumentorHarness(closedRow);
        findById.mockResolvedValue(closedRow);
        instrumentor.onPositionOpened(closedRow);

        // Accrue some MAE first.
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_001_000 });

        await instrumentor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'execution.reduce.fill.terminal',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(save).toHaveBeenCalledTimes(1);
        const saved = save.mock.calls[0][0] as PositionEntity;
        expect(saved.stopGapPct).not.toBeNull();
        expect(saved.stopGapPct!.greaterThan(0)).toBe(true); // fill (29400) was below SL (29500) → positive gap
        // State dropped from accumulator post-close.
        expect(instrumentor.getLifeStats(42)).toBeNull();
    });

    it('CLOSED transition with TAKE_PROFIT exit writes stop_gap_pct=null (§1d reviewer rule)', async () => {
        const closedRow = buildPositionRow({
            state: PositionStateEnum.CLOSED,
            exitReason: ExitReasonEnum.TAKE_PROFIT,
            exitPrice: new Money('30500'),
            stopLossPrice: new Money('29500'),
        });
        const { instrumentor, save, findById } = buildInstrumentorHarness(closedRow);
        findById.mockResolvedValue(closedRow);
        instrumentor.onPositionOpened(closedRow);

        await instrumentor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'execution.reduce.fill.terminal',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        const saved = save.mock.calls[0][0] as PositionEntity;
        expect(saved.stopGapPct).toBeNull();
    });

    it('RECONCILING transition drops accumulator WITHOUT flushing (drift state not persisted, §2)', async () => {
        const row = buildPositionRow();
        const { instrumentor, save, findById } = buildInstrumentorHarness(row);
        findById.mockResolvedValue(row);
        instrumentor.onPositionOpened(row);
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_001_000 });

        await instrumentor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.OPEN,
            toState: PositionStateEnum.RECONCILING,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'reconciliation.drift.detected',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(save).not.toHaveBeenCalled();
        expect(instrumentor.getLifeStats(42)).toBeNull();
    });

    it('MANUAL_ADOPTED_UNMANAGED transition drops accumulator WITHOUT flushing', async () => {
        const row = buildPositionRow();
        const { instrumentor, save, findById } = buildInstrumentorHarness(row);
        findById.mockResolvedValue(row);
        instrumentor.onPositionOpened(row);
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_001_000 });

        await instrumentor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.RECONCILING,
            toState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'reconciliation.resolved',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(save).not.toHaveBeenCalled();
        expect(instrumentor.getLifeStats(42)).toBeNull();
    });

    it('CLOSING transition keeps the accumulator (closing positions still accrue MAE/MFE on reduce ticks)', async () => {
        const row = buildPositionRow();
        const { instrumentor } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        await instrumentor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.OPEN,
            toState: PositionStateEnum.CLOSING,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'execution.reduce.fill.terminal',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(instrumentor.getLifeStats(42)).not.toBeNull();
    });

    it('CLOSED for an untracked positionId is a safe no-op (defensive)', async () => {
        const { instrumentor, save } = buildInstrumentorHarness();

        await instrumentor.onPositionStateTransitioned({
            positionId: 999,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: 1_700_000_005_000,
            eventClass: 'execution.reduce.fill.terminal',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(save).not.toHaveBeenCalled();
    });
});

describe('PositionInstrumentor — getLifeStats read-API (ADR 0013 §4)', () => {
    it('returns null for an untracked positionId', () => {
        const { instrumentor } = buildInstrumentorHarness();

        expect(instrumentor.getLifeStats(42)).toBeNull();
    });

    it('returns the live in-memory snapshot (subsecond freshness, no DB read)', () => {
        const row = buildPositionRow();
        const { instrumentor, findById } = buildInstrumentorHarness(row);
        instrumentor.onPositionOpened(row);

        const stats = instrumentor.getLifeStats(42);

        expect(stats).not.toBeNull();
        expect(stats!.positionId).toBe(42);
        // No DB call should be needed for the read.
        expect(findById).not.toHaveBeenCalled();
    });
});
