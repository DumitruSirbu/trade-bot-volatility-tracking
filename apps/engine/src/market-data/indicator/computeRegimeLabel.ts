import { RegimeLabelEnum } from '@bot/shared';

import { ADX_RANGING_MAX, ADX_TRENDING_MIN } from '../const';

// Regime from ADX(14): < 20 ranging; > 25 trending (direction by ±DI); 20–25
// transitioning. ADX is lagging by design — it labels "ranging" exactly as a new
// trend starts (the most dangerous moment to fade), which is why M1 also maintains
// fast market-stress inputs that do not depend on ADX.
export function computeRegimeLabel(adx: number, diPlus: number, diMinus: number): RegimeLabelEnum {
    if (adx < ADX_RANGING_MAX) {
        return RegimeLabelEnum.RANGING;
    }

    if (adx > ADX_TRENDING_MIN) {
        return diPlus >= diMinus ? RegimeLabelEnum.TRENDING_UP : RegimeLabelEnum.TRENDING_DOWN;
    }

    return RegimeLabelEnum.TRANSITIONING;
}
