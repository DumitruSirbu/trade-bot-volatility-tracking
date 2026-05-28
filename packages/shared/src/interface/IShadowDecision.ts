// M11a W0.5: Shadow decision DTO describing a row in the shadow_decisions table.
// Recorded when a non-executed version (v0, v2, v3) emits a decision over the soak's event tape.
// Fields mirror the decisions table plus shadow_version, virtual_slot_state_snapshot, and simulated_fill.
import { ISimulatedFill } from './ISimulatedFill.js';
import { IVirtualLedgerSnapshot } from './IVirtualLedgerSnapshot.js';

export interface IShadowDecision {
    readonly id: string; // uuid
    readonly createdAt: string; // ISO timestamp
    readonly eventId: string; // references the event that triggered this decision
    readonly shadowVersion: string; // discriminator: 'v0', 'v2', 'v3'
    readonly virtualSlotStateSnapshot: IVirtualLedgerSnapshot; // ledger state at gate-evaluation time
    readonly simulatedFill: ISimulatedFill | null; // null if gate rejected or strategy skipped
    // Additional fields may be present (decision details, gate outcome) — these are the minimum for W0.5.
}
