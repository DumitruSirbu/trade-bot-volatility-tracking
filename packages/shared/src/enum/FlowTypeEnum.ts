// PLACEHOLDER — values are provisional; flow is classified in M3.
// Carried as a placeholder field on the M1 payload so the contract is stable.
export enum FlowTypeEnum {
    UNCLASSIFIED = 'unclassified',
    LIQUIDATION_CASCADE = 'liquidation_cascade',
    NEW_MONEY = 'new_money',
    CATALYST = 'catalyst',
}
