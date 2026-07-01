import { CoinTierEnum } from '../../enum/CoinTierEnum.js';
import { RejectReasonEnum } from '../../enum/RejectReasonEnum.js';
import { extractGateDetail } from '../extractGateDetail.js';

describe('extractGateDetail', () => {
    const snapshot = {
        coin_tier: CoinTierEnum.TIER_1,
        book_depth_10bps_usdt: '3548.9824998',
    };

    it('returns depth vs floor label and hint for coin_book_too_thin', () => {
        const result = extractGateDetail(RejectReasonEnum.COIN_BOOK_TOO_THIN, snapshot);

        expect(result).toEqual({
            label: '$3,549 / $10,000 · 35%',
            hint: '10bps one-sided depth $3548.98 — tier1 floor $10000 — short $6451.02',
        });
    });

    it('returns null for other reject reasons', () => {
        expect(extractGateDetail('spread_too_wide', snapshot)).toBeNull();
    });

    it('returns null when snapshot is missing depth or tier', () => {
        expect(extractGateDetail(RejectReasonEnum.COIN_BOOK_TOO_THIN, { coin_tier: CoinTierEnum.TIER_1 })).toBeNull();
        expect(extractGateDetail(RejectReasonEnum.COIN_BOOK_TOO_THIN, { book_depth_10bps_usdt: '1000' })).toBeNull();
    });

    it('uses tier-2 and tier-3 floors', () => {
        const tier2 = extractGateDetail(RejectReasonEnum.COIN_BOOK_TOO_THIN, {
            coin_tier: CoinTierEnum.TIER_2,
            book_depth_10bps_usdt: '2000',
        });

        expect(tier2?.label).toBe('$2,000 / $2,500 · 80%');
    });
});
