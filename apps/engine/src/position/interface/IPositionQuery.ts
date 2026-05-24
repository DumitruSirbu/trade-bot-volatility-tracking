import { PositionEntity } from '../entity';

// Minimal read-only seam consumed by RiskGateService for ADR 0010 §1b/§1c
// reconciliation primitives. Surface is intentionally narrow — only `findById`,
// because that is the sole method the gate calls on the position store.
export interface IPositionQuery {
    findById(id: number): Promise<PositionEntity | null>;
}

// DI token — the interface is erased at runtime, so providers bind to this symbol.
// Mirrors the `EXCHANGE_CLIENT` token convention from `IExchangeClient.ts`.
export const POSITION_QUERY = Symbol('POSITION_QUERY');
