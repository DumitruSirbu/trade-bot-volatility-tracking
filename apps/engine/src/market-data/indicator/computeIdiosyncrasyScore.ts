import { IDIOSYNCRASY_MIN_COIN_MOVE_PCT, IDIOSYNCRASY_SCORE_MAX, IDIOSYNCRASY_SCORE_MIN } from '../const';

// Idiosyncrasy score: 1 − abs(btc 5m move) / abs(coin 5m move), clamped to [0,1].
// ≥ 0.5 = idiosyncratic (coin moving on its own) per the live per-version DB
// param `idiosyncrasy_min_score = 0.5`; below it = BTC-correlated. A coin with
// no move of its own (denominator 0) cannot be idiosyncratic → score 0.
// A sub-IDIOSYNCRASY_MIN_COIN_MOVE_PCT coin move is treated as noise → score 0;
// the floor is 16× below the tightest tier-1 trigger (0.8%), so it never fires
// on real inputs (tightening-only — it can only remove false eligibility, M30 D4).
export function computeIdiosyncrasyScore(btc5mMovePct: number, coin5mMovePct: number): number {
    const coinMagnitude = Math.abs(coin5mMovePct);

    if (coinMagnitude === 0) {
        return IDIOSYNCRASY_SCORE_MIN;
    }

    if (coinMagnitude < IDIOSYNCRASY_MIN_COIN_MOVE_PCT) {
        return IDIOSYNCRASY_SCORE_MIN;
    }

    const raw = 1 - Math.abs(btc5mMovePct) / coinMagnitude;

    return Math.min(IDIOSYNCRASY_SCORE_MAX, Math.max(IDIOSYNCRASY_SCORE_MIN, raw));
}
