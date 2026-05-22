// Market breadth: % of the universe trading up over the 1m/5m/15m windows.
export interface IBreadthSnapshot {
    upPct1m: number;
    upPct5m: number;
    upPct15m: number;
}
