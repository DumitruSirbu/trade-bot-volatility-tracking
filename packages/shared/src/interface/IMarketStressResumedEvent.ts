export interface IMarketStressResumedEvent {
    triggerLeg: string;
    clearCount: number;
    breadthAtResume: number;
    dailyReHaltCount: number;
    utcDateString: string;
    nearReHaltCap: boolean;
}
