export interface IHaltStateView {
    isHalted: boolean;
    haltReason: string | null;
    asOf: string; // ISO timestamp string
}
