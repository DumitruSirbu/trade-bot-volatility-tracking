import { ICandle } from '../interface';

// RSI(period) (Wilder). A bounded 0–100 momentum oscillator — dimensionless, so
// computed as a plain number from close-to-close changes. Returns 50 (neutral)
// when there are not enough bars to seed, and 100 when there is no downside.
export function computeRsi(bars: ICandle[], period: number): number {
    if (bars.length <= period) {
        return 50;
    }

    const changes: number[] = [];

    for (let index = 1; index < bars.length; index += 1) {
        changes.push(bars[index].close.minus(bars[index - 1].close).toNumber());
    }

    let avgGain = average(changes.slice(0, period).map((change) => (change > 0 ? change : 0)));
    let avgLoss = average(changes.slice(0, period).map((change) => (change < 0 ? -change : 0)));

    for (let index = period; index < changes.length; index += 1) {
        const change = changes[index];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) {
        return 100;
    }

    const relativeStrength = avgGain / avgLoss;

    return 100 - 100 / (1 + relativeStrength);
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((total, value) => total + value, 0) / values.length;
}
