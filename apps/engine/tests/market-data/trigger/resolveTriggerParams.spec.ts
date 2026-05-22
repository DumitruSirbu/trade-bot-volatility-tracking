import { CoinTierEnum } from '@bot/shared';

import { resolveTriggerParams } from '../../../src/market-data/utils/resolveTriggerParams';
import { DEFAULT_VWAP_SIGMA_TRIGGER, DEFAULT_VOLUME_RATIO_MIN, TIER_ABS_MOVE_BANDS_PCT } from '../../../src/market-data/const/triggerConsts';

describe('resolveTriggerParams', () => {
    describe('sigma and volume defaults are tier-independent', () => {
        it('returns the default sigma trigger for tier 1', () => {
            const params = resolveTriggerParams(CoinTierEnum.TIER_1);

            expect(params.vwapSigmaTrigger).toBe(DEFAULT_VWAP_SIGMA_TRIGGER);
        });

        it('returns the default volume ratio for tier 2', () => {
            const params = resolveTriggerParams(CoinTierEnum.TIER_2);

            expect(params.volumeRatioMin).toBe(DEFAULT_VOLUME_RATIO_MIN);
        });

        it('returns the same sigma and volume defaults across all three tiers', () => {
            const tier1 = resolveTriggerParams(CoinTierEnum.TIER_1);
            const tier2 = resolveTriggerParams(CoinTierEnum.TIER_2);
            const tier3 = resolveTriggerParams(CoinTierEnum.TIER_3);

            expect(tier1.vwapSigmaTrigger).toBe(tier2.vwapSigmaTrigger);
            expect(tier2.vwapSigmaTrigger).toBe(tier3.vwapSigmaTrigger);
            expect(tier1.volumeRatioMin).toBe(tier2.volumeRatioMin);
            expect(tier2.volumeRatioMin).toBe(tier3.volumeRatioMin);
        });
    });

    describe('per-tier absolute move bands', () => {
        it('returns the tier-1 min and max bands for tier 1', () => {
            const params = resolveTriggerParams(CoinTierEnum.TIER_1);

            expect(params.tierMinAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_1].min);
            expect(params.tierMaxAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_1].max);
        });

        it('returns the tier-2 min and max bands for tier 2', () => {
            const params = resolveTriggerParams(CoinTierEnum.TIER_2);

            expect(params.tierMinAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_2].min);
            expect(params.tierMaxAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_2].max);
        });

        it('returns the tier-3 min and max bands for tier 3', () => {
            const params = resolveTriggerParams(CoinTierEnum.TIER_3);

            expect(params.tierMinAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_3].min);
            expect(params.tierMaxAbsMovePct).toBe(TIER_ABS_MOVE_BANDS_PCT[CoinTierEnum.TIER_3].max);
        });

        it('tier-1 has a tighter cap than tier-2 (more liquid, lower volatility)', () => {
            const tier1 = resolveTriggerParams(CoinTierEnum.TIER_1);
            const tier2 = resolveTriggerParams(CoinTierEnum.TIER_2);

            expect(tier1.tierMaxAbsMovePct).toBeLessThan(tier2.tierMaxAbsMovePct);
        });

        it('tier-2 has a tighter cap than tier-3', () => {
            const tier2 = resolveTriggerParams(CoinTierEnum.TIER_2);
            const tier3 = resolveTriggerParams(CoinTierEnum.TIER_3);

            expect(tier2.tierMaxAbsMovePct).toBeLessThan(tier3.tierMaxAbsMovePct);
        });

        it('min band is always less than max band for every tier', () => {
            for (const tier of [CoinTierEnum.TIER_1, CoinTierEnum.TIER_2, CoinTierEnum.TIER_3]) {
                const params = resolveTriggerParams(tier);

                expect(params.tierMinAbsMovePct).toBeLessThan(params.tierMaxAbsMovePct);
            }
        });
    });
});
