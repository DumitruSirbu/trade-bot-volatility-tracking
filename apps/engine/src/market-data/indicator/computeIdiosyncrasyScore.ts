import { IDIOSYNCRASY_SCORE_MAX, IDIOSYNCRASY_SCORE_MIN } from '../const';

// Idiosyncrasy score: 1 − abs(btc 5m move) / abs(coin 5m move), clamped to [0,1].
// > 0.5 = idiosyncratic (coin moving on its own); < 0.3 = BTC-correlated. A coin
// with no move of its own (denominator 0) cannot be idiosyncratic → score 0.
export function computeIdiosyncrasyScore(btc5mMovePct: number, coin5mMovePct: number): number {
    const coinMagnitude = Math.abs(coin5mMovePct);

    if (coinMagnitude === 0) {
        return IDIOSYNCRASY_SCORE_MIN;
    }

    const raw = 1 - Math.abs(btc5mMovePct) / coinMagnitude;

    return Math.min(IDIOSYNCRASY_SCORE_MAX, Math.max(IDIOSYNCRASY_SCORE_MIN, raw));
}
