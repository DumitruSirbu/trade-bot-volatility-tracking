export enum StrategyStatusEnum {
    DRAFT = 'draft',
    ACTIVE = 'active',
    // Non-active, non-archived version registered for the M11a shadow-mode
    // counterfactual (ADR 0029 §2.2). The shadow orchestrator filters strategy
    // versions on this status — DRAFT rows are explicitly NOT shadowed so a
    // pre-promotion draft cannot accidentally receive synthetic decision calls.
    SHADOW = 'shadow',
    ARCHIVED = 'archived',
}
