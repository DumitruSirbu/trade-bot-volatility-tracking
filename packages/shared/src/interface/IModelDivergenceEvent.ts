export interface IModelDivergenceEvent {
    engagedAt: string;
    reason: string;
    observedSlippageBps: string | null;
    modeledSlippageBps: string | null;
    sampleCount: number;
}
