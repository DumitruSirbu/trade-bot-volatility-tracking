import { DeviationSideEnum, IVolatilityDetectedEvent, PositionSideEnum, SignalTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';

const PCT_DIVISOR = new Money(100);
const ONE = new Money(1);

// Shared, pure entry-side helpers used by v1/v2/v3 so the fade/follow logic and the
// reference-price reconstruction live in one place (no DRY violation across versions).

// Signal type records what the detector classified (event class), independent of the act
// taken: a positive deviation is a long-bias event, a negative one a short-bias event.
export function resolveSignalType(event: IVolatilityDetectedEvent): SignalTypeEnum {
    if (event.side === DeviationSideEnum.ABOVE) {
        return SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS;
    }

    return SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS;
}

// Mean-reversion FADES the spike: price above VWAP → short, below → long.
export function resolveFadeSide(event: IVolatilityDetectedEvent): PositionSideEnum {
    if (event.side === DeviationSideEnum.ABOVE) {
        return PositionSideEnum.SHORT;
    }

    return PositionSideEnum.LONG;
}

// Momentum FOLLOWS the spike: price above VWAP → long, below → short.
export function resolveFollowSide(event: IVolatilityDetectedEvent): PositionSideEnum {
    if (event.side === DeviationSideEnum.ABOVE) {
        return PositionSideEnum.LONG;
    }

    return PositionSideEnum.SHORT;
}

// Deterministic entry-reference price reconstructed from the closed bar: the close that
// deviated from VWAP = vwapSession × (1 + vwapDeviationPct / 100). Used as the proposed
// entry price in dry-run (no fill exists yet); live fills replace it downstream.
export function reconstructReferencePrice(event: IVolatilityDetectedEvent): MoneyValue {
    const vwap = new Money(event.vwapSession);
    const deviationFactor = ONE.plus(new Money(event.vwapDeviationPct).dividedBy(PCT_DIVISOR));

    return vwap.times(deviationFactor);
}

// The deviation wick the price pierced — the Bollinger band on the deviation side. Drives
// the structural stop placement.
export function resolveDeviationWickPrice(event: IVolatilityDetectedEvent): MoneyValue {
    if (event.side === DeviationSideEnum.ABOVE) {
        return new Money(event.bollingerUpper);
    }

    return new Money(event.bollingerLower);
}
