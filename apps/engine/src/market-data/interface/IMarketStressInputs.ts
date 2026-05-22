// Fast market-stress inputs, independent of the lagging ADX (M1 task; feed M4's
// global market-stress halt). Maintained continuously from streamed ticker data.
export interface IMarketStressInputs {
    btc1mMovePct: number;
    btc5mMovePct: number;
    eth1mMovePct: number;
    eth5mMovePct: number;
    btc1mShock: boolean;
    btc5mShock: boolean;
    eth5mShock: boolean;
    oiShock: boolean;
    fundingExtreme: boolean;
    spreadWidening: boolean;
    depthCollapse: boolean;
}
