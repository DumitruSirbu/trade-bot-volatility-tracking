import { IAdxResult, ICandle } from '../interface';

// ADX(period) with +DI/−DI (Wilder). Directional indices and ADX are dimensionless
// (0–100) — computed as plain numbers from price differences. Returns zeros when
// there are not enough bars to warm up (needs ~2× period). The directional
// movement / true-range smoothing follows Wilder's original RMA recursion.
export function computeAdx(bars: ICandle[], period: number): IAdxResult {
    const empty: IAdxResult = { adx: 0, diPlus: 0, diMinus: 0 };

    if (bars.length < period * 2) {
        return empty;
    }

    const { plusDm, minusDm, trueRange } = computeDirectionalMovement(bars);

    let smoothedTr = sum(trueRange.slice(0, period));
    let smoothedPlusDm = sum(plusDm.slice(0, period));
    let smoothedMinusDm = sum(minusDm.slice(0, period));

    const dxValues: number[] = [];

    for (let index = period; index < trueRange.length; index += 1) {
        smoothedTr = smoothedTr - smoothedTr / period + trueRange[index];
        smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDm[index];
        smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDm[index];

        const diPlus = smoothedTr === 0 ? 0 : (smoothedPlusDm / smoothedTr) * 100;
        const diMinus = smoothedTr === 0 ? 0 : (smoothedMinusDm / smoothedTr) * 100;
        const diSum = diPlus + diMinus;
        const dx = diSum === 0 ? 0 : (Math.abs(diPlus - diMinus) / diSum) * 100;

        dxValues.push(dx);
    }

    return finalize(dxValues, period, smoothedTr, smoothedPlusDm, smoothedMinusDm);
}

function finalize(dxValues: number[], period: number, smoothedTr: number, smoothedPlusDm: number, smoothedMinusDm: number): IAdxResult {
    if (dxValues.length < period) {
        return { adx: 0, diPlus: 0, diMinus: 0 };
    }

    let adx = sum(dxValues.slice(0, period)) / period;

    for (let index = period; index < dxValues.length; index += 1) {
        adx = (adx * (period - 1) + dxValues[index]) / period;
    }

    const diPlus = smoothedTr === 0 ? 0 : (smoothedPlusDm / smoothedTr) * 100;
    const diMinus = smoothedTr === 0 ? 0 : (smoothedMinusDm / smoothedTr) * 100;

    return { adx, diPlus, diMinus };
}

function computeDirectionalMovement(bars: ICandle[]): {
    plusDm: number[];
    minusDm: number[];
    trueRange: number[];
} {
    const plusDm: number[] = [];
    const minusDm: number[] = [];
    const trueRange: number[] = [];

    for (let index = 1; index < bars.length; index += 1) {
        const current = bars[index];
        const previous = bars[index - 1];

        const upMove = current.high.minus(previous.high).toNumber();
        const downMove = previous.low.minus(current.low).toNumber();

        plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);

        const highLow = current.high.minus(current.low).abs().toNumber();
        const highClose = current.high.minus(previous.close).abs().toNumber();
        const lowClose = current.low.minus(previous.close).abs().toNumber();

        trueRange.push(Math.max(highLow, highClose, lowClose));
    }

    return { plusDm, minusDm, trueRange };
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
