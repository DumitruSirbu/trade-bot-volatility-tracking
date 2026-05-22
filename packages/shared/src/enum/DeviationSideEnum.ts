// NOTE: this is the deviation DIRECTION of the event (price vs VWAP),
// NOT a trade direction. Trade direction is decided downstream by the strategy.
export enum DeviationSideEnum {
    ABOVE = 'above', // price above VWAP (positive deviation)
    BELOW = 'below', // price below VWAP (negative deviation)
}
