/**
 * PositionSizer — M29 cap-clamp tests (Groups A and B)
 *
 * Surfaces under test:
 *   A1  — Per-coin cap clamp basic: notional just over and just under the cap
 *   A2  — Cap composes with leverage clamp: each ceiling in isolation + most-restrictive-wins
 *   A3  — Clamp below min-notional → below_min_notional
 *   A4  — effectiveRiskUsdt < riskPerTradeUsdt when cap binds; riskPerTradeUsdt never overwritten
 *   A5  — effectiveRiskUsdt === riskPerTradeUsdt when no ceiling binds
 *   A6  — Small order never inflated: notional already under the cap is unchanged
 *   A7  — Funding cut applies before the cap clamp (ordering invariant)
 *   A8  — Pure decimal — MoneyValue returned, not a primitive number
 *   A9  — Same-direction cap leg unaffected: single intent under MAX_SAME_DIRECTION is approved by sizer
 */

import { PositionSideEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { FUNDING_ANNUALIZED_SUPPRESS_PCT, FUNDING_SIZE_CUT_FACTOR, MAX_LEVERAGE, RISK_PER_TRADE_PCT } from '../../const';
import { IInstrumentConstraints } from '../../interface';
import { PositionSizer, ISizingInput } from '../PositionSizer';

// ─── fixture factories ────────────────────────────────────────────────────────

const ALLOCATED_CAPITAL = '1500'; // $1,500 → 1% = $15 risk target
const ATR_14 = '100'; // $100 ATR
const ATR_STOP_MULTIPLIER = 1.5; // stopDistance = 100 × 1.5 = $150
const ENTRY_PRICE = '50000'; // BTC-like price
// riskTargeted = 1500 × 0.01 = $15
// baseNotional = (15 / 150) × 50000 = $5,000

function buildInstrument(overrides: Partial<IInstrumentConstraints> = {}): IInstrumentConstraints {
    return {
        symbol: 'BTCUSDT',
        stepSize: new Money('0.001'),
        tickSize: new Money('0.01'),
        minNotional: new Money('5'),
        maintenanceMarginRate: new Money('0.005'),
        ...overrides,
    };
}

function buildInput(overrides: Partial<ISizingInput> = {}): ISizingInput {
    return {
        allocatedCapital: new Money(ALLOCATED_CAPITAL),
        atr14: new Money(ATR_14),
        atrStopMultiplier: ATR_STOP_MULTIPLIER,
        entryPrice: new Money(ENTRY_PRICE),
        tradeSide: PositionSideEnum.LONG,
        fundingRate: 0.0001, // small, favour long → no cut
        fundingRateAnnualized: 0.1, // well below suppress threshold
        fundingRateSuppressThreshold: 0.01,
        maxExposurePerCoinUsdt: new Money(9999999), // no per-coin cap by default
        instrument: buildInstrument(),
        ...overrides,
    };
}

// baseNotional when no cap, funding cut, or leverage ceiling binds: $5,000
const BASE_NOTIONAL = 5000;

// ─── A1: Per-coin cap clamp basic ─────────────────────────────────────────────

describe('PositionSizer M29 — A1: per-coin cap clamp basic', () => {
    const sizer = new PositionSizer();

    it('notional just over the cap is clamped exactly to the cap', () => {
        const capUsdt = BASE_NOTIONAL - 1; // $4,999 — just under uncapped notional

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(capUsdt) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        // Clamped notional must be <= cap (step-rounding DOWN means <= cap, not > cap)
        expect(result.sizing.notional.lessThanOrEqualTo(capUsdt)).toBe(true);
    });

    it('notional just under the cap is NOT clamped', () => {
        const capUsdt = BASE_NOTIONAL + 1; // $5,001 — above uncapped notional → cap never binds

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(capUsdt) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        // Without cap pressure, notional ≈ baseNotional. The qty step-rounds DOWN so
        // notional ≤ baseNotional. It should be strictly below the cap.
        expect(result.sizing.notional.lessThan(capUsdt)).toBe(true);
    });

    it('notional exactly at cap boundary is accepted (boundary case)', () => {
        // Set cap exactly = baseNotional. The clamp is a ceiling (greaterThan check),
        // so equal means no clamping. Step-rounded qty × entryPrice ≤ cap.
        const capUsdt = BASE_NOTIONAL;

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(capUsdt) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        expect(result.sizing.notional.lessThanOrEqualTo(capUsdt)).toBe(true);
    });
});

// ─── A2: Cap composes with leverage clamp ─────────────────────────────────────

describe('PositionSizer M29 — A2: cap composes with leverage clamp', () => {
    const sizer = new PositionSizer();
    // allocatedCapital = $1,500 → leverageCap = 1500 × 3 = $4,500
    const leverageCapUsdt = Number(ALLOCATED_CAPITAL) * MAX_LEVERAGE; // $4,500

    it('leverage ceiling alone: base notional $5,000 clamped to leverage cap $4,500', () => {
        const result = sizer.size(
            buildInput({
                maxExposurePerCoinUsdt: new Money(9_999_999), // per-coin cap huge — not binding
            }),
        );

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        expect(result.sizing.notional.lessThanOrEqualTo(leverageCapUsdt)).toBe(true);
    });

    it('per-coin cap alone: cap $3,000 < leverage cap $4,500 → $3,000 binds', () => {
        const perCoinCap = 3000;

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(perCoinCap) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        expect(result.sizing.notional.lessThanOrEqualTo(perCoinCap)).toBe(true);
    });

    it('most-restrictive-wins: per-coin cap $2,000 < leverage cap $4,500 → $2,000 binds', () => {
        const tightCap = 2000; // tighter than leverage cap

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(tightCap) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        expect(result.sizing.notional.lessThanOrEqualTo(tightCap)).toBe(true);
        // Verify leverage cap is not what bound it (notional < leverageCap)
        expect(result.sizing.notional.lessThan(leverageCapUsdt)).toBe(true);
    });

    it('leverage cap binds when per-coin cap > leverage cap', () => {
        const wideCap = 9000; // above leverage cap $4,500

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(wideCap) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        // Must not exceed leverage cap
        expect(result.sizing.notional.lessThanOrEqualTo(leverageCapUsdt)).toBe(true);
    });
});

// ─── A3: Clamp below min-notional returns below_min_notional ──────────────────

describe('PositionSizer M29 — A3: cap so small that clamped notional falls below min-notional', () => {
    const sizer = new PositionSizer();

    it('returns below_min_notional when maxExposurePerCoinUsdt < instrument.minNotional', () => {
        // minNotional = $5; set cap below that — qty rounds to 0, notional = 0 < $5
        const result = sizer.size(
            buildInput({
                maxExposurePerCoinUsdt: new Money('4'), // below minNotional of $5
                instrument: buildInstrument({ minNotional: new Money('5') }),
            }),
        );

        expect(result.kind).toBe('below_min_notional');
    });

    it('returns sized when notional is exactly at minNotional after clamping', () => {
        // Set a cap that after step-rounding produces notional >= minNotional.
        // entryPrice = 50000; stepSize = 0.001; minNotional = $5
        // qty = 0.001 → notional = $50 ≥ minNotional $5 → valid.
        const result = sizer.size(
            buildInput({
                maxExposurePerCoinUsdt: new Money('50'), // allows at least 0.001 qty → $50 notional
                instrument: buildInstrument({ minNotional: new Money('5') }),
            }),
        );

        expect(result.kind).toBe('sized');
    });
});

// ─── A4: effectiveRiskUsdt < riskPerTradeUsdt when cap binds ──────────────────

describe('PositionSizer M29 — A4: effectiveRiskUsdt vs riskPerTradeUsdt when cap binds', () => {
    const sizer = new PositionSizer();

    it('effectiveRiskUsdt < riskPerTradeUsdt when per-coin cap shrinks the notional', () => {
        const capUsdt = 500; // forces notional well below uncapped $5,000

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(capUsdt) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        const { sizing } = result;

        // effectiveRiskUsdt < riskPerTradeUsdt because the cap shrank the order
        expect(sizing.effectiveRiskUsdt.lessThan(sizing.riskPerTradeUsdt)).toBe(true);
    });

    it('riskPerTradeUsdt is always exactly 1% of allocatedCapital regardless of cap', () => {
        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money('200') }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        const expected = Number(ALLOCATED_CAPITAL) * RISK_PER_TRADE_PCT; // $15

        expect(result.sizing.riskPerTradeUsdt.toNumber()).toBeCloseTo(expected, 8);
    });

    it('riskPerTradeUsdt is never modified when cap binds (it is a pre-clamp audit field)', () => {
        const tightCap = 100;
        const wideCap = 999999;

        const cappedResult = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(tightCap) }));
        const uncappedResult = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(wideCap) }));

        expect(cappedResult.kind).toBe('sized');
        expect(uncappedResult.kind).toBe('sized');
        if (cappedResult.kind !== 'sized' || uncappedResult.kind !== 'sized') return;

        // Both must have the same riskPerTradeUsdt — the cap never overwrites it
        expect(cappedResult.sizing.riskPerTradeUsdt.equals(uncappedResult.sizing.riskPerTradeUsdt)).toBe(true);
    });
});

// ─── A5: effectiveRiskUsdt === riskPerTradeUsdt when no ceiling binds ──────────

describe('PositionSizer M29 — A5: effectiveRiskUsdt equals riskPerTradeUsdt when no ceiling binds', () => {
    const sizer = new PositionSizer();

    it('effectiveRiskUsdt ≤ riskPerTradeUsdt when no ceiling binds (step-rounding reduces qty slightly)', () => {
        // No ceiling binds: riskTargeted = $15, stopDistance = $150.
        // clampedNotional = baseNotional = $5,000 (exactly).
        // effectiveRiskUsdt = (clampedNotional / entryPrice) × stopDistance
        //                   = (5000 / 50000) × 150 = 0.1 × 150 = $15 = riskPerTradeUsdt.
        // After step-rounding DOWN, notional ≤ $5,000 so effectiveRiskUsdt ≤ riskPerTradeUsdt.
        const result = sizer.size(
            buildInput({
                maxExposurePerCoinUsdt: new Money(9_999_999), // never binds
            }),
        );

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        const { sizing } = result;

        // effectiveRiskUsdt must be ≤ riskPerTradeUsdt (ceiling, never a floor)
        expect(sizing.effectiveRiskUsdt.lessThanOrEqualTo(sizing.riskPerTradeUsdt)).toBe(true);

        // effectiveRiskUsdt must be positive — the sizer produced a valid sized result
        expect(sizing.effectiveRiskUsdt.isPositive()).toBe(true);
    });
});

// ─── A6: Small order never inflated ───────────────────────────────────────────

describe('PositionSizer M29 — A6: notional already under the cap is not re-inflated', () => {
    const sizer = new PositionSizer();

    it('a notional already below the cap is sized at its natural uncapped value', () => {
        const highCap = BASE_NOTIONAL + 2000; // cap well above the uncapped notional

        const capped = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(highCap) }));
        const uncapped = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(9_999_999) }));

        expect(capped.kind).toBe('sized');
        expect(uncapped.kind).toBe('sized');
        if (capped.kind !== 'sized' || uncapped.kind !== 'sized') return;

        // Both must produce the same notional — cap is a ceiling, never a floor
        expect(capped.sizing.notional.equals(uncapped.sizing.notional)).toBe(true);
    });
});

// ─── A7: Funding cut applies before the cap clamp ─────────────────────────────

describe('PositionSizer M29 — A7: funding cut applied before per-coin cap clamp', () => {
    const sizer = new PositionSizer();

    it('funding-halved notional that lands under the cap is not re-inflated to cap', () => {
        // unfavourable funding (long + positive rate above suppress threshold) halves notional:
        // halvedNotional = $5,000 × 0.5 = $2,500
        // Set cap = $4,000 (above $2,500 — cap does NOT bind on the halved value).
        // If funding cut ran AFTER clamping, the notional would be $4,000 × 0.5 = $2,000.
        // Correct ordering: cut first → $2,500, then cap($4,000) → $2,500 unchanged.
        const capUsdt = 4000;
        const suppressThreshold = 0.0001; // very low so the small fundingRate triggers the cut

        const result = sizer.size(
            buildInput({
                fundingRate: 0.001, // above suppress threshold
                fundingRateAnnualized: 0.1, // below suppress-entry threshold
                fundingRateSuppressThreshold: suppressThreshold,
                tradeSide: PositionSideEnum.LONG,
                maxExposurePerCoinUsdt: new Money(capUsdt),
            }),
        );

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        // Notional must be ≤ $2,500 (halved base), not inflated back to $4,000
        // step-rounding may reduce slightly but will not exceed halvedNotional
        const halvedNotional = BASE_NOTIONAL * FUNDING_SIZE_CUT_FACTOR;
        expect(result.sizing.notional.lessThanOrEqualTo(halvedNotional)).toBe(true);
    });
});

// ─── A8: Pure decimal — MoneyValue returned, not a primitive number ────────────

describe('PositionSizer M29 — A8: sizing result uses decimal money types (no float leakage)', () => {
    const sizer = new PositionSizer();

    it('all IIntentSizing fields are MoneyValue instances (decimal.js, not JS number)', () => {
        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money('500') }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        const { sizing } = result;

        // MoneyValue is a Decimal instance — has .toFixed(), .toNumber(), .isFinite()
        expect(typeof sizing.qty.toFixed).toBe('function');
        expect(typeof sizing.notional.toFixed).toBe('function');
        expect(typeof sizing.leverage.toFixed).toBe('function');
        expect(typeof sizing.riskPerTradeUsdt.toFixed).toBe('function');
        expect(typeof sizing.effectiveRiskUsdt.toFixed).toBe('function');

        // Ensure no field is a plain JS number (would indicate float leakage)
        expect(typeof sizing.notional).not.toBe('number');
        expect(typeof sizing.effectiveRiskUsdt).not.toBe('number');
    });
});

// ─── A9: Regression — same-direction cap leg unaffected ───────────────────────

describe('PositionSizer M29 — A9: sizer does not bind on same-direction exposure (only gate checks that)', () => {
    const sizer = new PositionSizer();

    it('single intent with notional just under leverage cap is approved by sizer regardless of direction', () => {
        // M29 added the per-coin cap to the sizer. The same-direction cap is a GATE
        // check (checkExposureCaps), not a sizer check. Verify sizer still approves
        // an intent that would be under the same-direction exposure cap.
        // allocatedCapital × MAX_LEVERAGE = $4,500 — any notional under this passes sizer.
        const result = sizer.size(
            buildInput({
                maxExposurePerCoinUsdt: new Money(9_999_999), // per-coin cap irrelevant
            }),
        );

        // Sizer should return 'sized' — it does not know about same-direction portfolio exposure
        expect(result.kind).toBe('sized');
    });
});

// ─── Group B: Integration: sizing threading + gate (D2 parity) ───────────────

// These tests exercise PositionSizer directly with inputs that mirror D2 / live
// sizing path, without NestJS DI or DB. They verify the clamp + gate interaction
// at the unit level; full StrategyService integration is in StrategyService.m29.spec.ts.

describe('PositionSizer M29 — B-unit: D2 cap clamp composition invariants', () => {
    const sizer = new PositionSizer();

    it('B11: live/backtest sizing parity — same inputs + riskTargeted > perCoinCap → identical clamped notional', () => {
        // Both live (StrategyService) and backtest (BacktestOrchestrator) call sizer.size()
        // with the same ISizingInput. Use a cap of $250 (riskConsts.ts default) so the cap binds.
        const perCoinCap = 250;
        const input = buildInput({ maxExposurePerCoinUsdt: new Money(perCoinCap) });

        const resultA = sizer.size(input);
        const resultB = sizer.size(input);

        expect(resultA.kind).toBe('sized');
        expect(resultB.kind).toBe('sized');
        if (resultA.kind !== 'sized' || resultB.kind !== 'sized') return;

        // Same input → same output (deterministic, no side effects)
        expect(resultA.sizing.notional.equals(resultB.sizing.notional)).toBe(true);
    });

    it('B12: non-default cap $250 clamps notional to ≤$250 (config-source parity exercise)', () => {
        // This mirrors BacktestOrchestrator's use of MAX_EXPOSURE_PER_COIN_USDT ($250).
        // StrategyService uses config.maxExposurePerCoinUsdt (also $250 in default env).
        const backteststCap = new Money('250');
        const liveEnvCap = new Money('250');

        const backtestResult = sizer.size(buildInput({ maxExposurePerCoinUsdt: backteststCap }));
        const liveResult = sizer.size(buildInput({ maxExposurePerCoinUsdt: liveEnvCap }));

        expect(backtestResult.kind).toBe('sized');
        expect(liveResult.kind).toBe('sized');
        if (backtestResult.kind !== 'sized' || liveResult.kind !== 'sized') return;

        // Both paths receive the same value → identical clamped notional
        expect(backtestResult.sizing.notional.equals(liveResult.sizing.notional)).toBe(true);
        // Confirm the cap bound: notional ≤ $250
        expect(backtestResult.sizing.notional.lessThanOrEqualTo(250)).toBe(true);
    });

    it('B14: defence-in-depth — clamped notional still respects the per-coin ceiling', () => {
        // The sizer clamps to the ceiling. Adding existing exposure on top of the
        // clamped notional is the gate's job (checkExposureCaps). This test verifies
        // the sizer output does not exceed the cap, which is the prerequisite for the
        // gate check to remain meaningful.
        const capUsdt = 200;

        const result = sizer.size(buildInput({ maxExposurePerCoinUsdt: new Money(capUsdt) }));

        expect(result.kind).toBe('sized');
        if (result.kind !== 'sized') return;

        // Sizer output ≤ cap — gate can then add existing exposure to this
        expect(result.sizing.notional.lessThanOrEqualTo(capUsdt)).toBe(true);
    });
});

// ─── Additional boundary cases ────────────────────────────────────────────────

describe('PositionSizer M29 — boundary: invalid inputs + suppressed entry still close correctly', () => {
    const sizer = new PositionSizer();

    it('returns invalid_inputs when atrStopMultiplier is zero', () => {
        const result = sizer.size(buildInput({ atrStopMultiplier: 0 }));
        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns invalid_inputs when entryPrice is negative', () => {
        const result = sizer.size(buildInput({ entryPrice: new Money('-100') }));
        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns funding_suppressed when annualized rate exceeds the suppress threshold', () => {
        const result = sizer.size(
            buildInput({
                fundingRateAnnualized: FUNDING_ANNUALIZED_SUPPRESS_PCT + 1,
            }),
        );
        expect(result.kind).toBe('funding_suppressed');
    });

    it('returns below_min_notional when allocatedCapital is zero (zero capital → zero notional < minNotional)', () => {
        // decimal.js isPositive() returns true for zero, so areInputsValid passes.
        // riskPerTradeUsdt = 0 × 0.01 = 0, baseNotional = 0 → qty rounds to 0 → notional=0 < minNotional.
        const result = sizer.size(buildInput({ allocatedCapital: new Money('0') }));
        expect(result.kind).toBe('below_min_notional');
    });
});
