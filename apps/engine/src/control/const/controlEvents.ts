import { HaltSourceEnum, HaltStateEnum } from '@bot/shared';

// M9 W6 — fills the bus-event gap W5 flagged: the WS gateway (and any future
// observer) needs a single, typed in-process event whenever the halt state
// flips. `HaltService` emits this AFTER the audit row is written + the M0
// halt flag is toggled, so any consumer that reacts to the event is reacting
// to a transition that is already durable.
//
// Kept here (control/const/) rather than in `common/const/eventConsts.ts`
// because the event is OWNED by the control module — emitter and the typed
// payload sit together (conventions §Constants Placement).
export const HALT_CHANGED_EVENT = 'control.halt.changed';

// Mirrors `@bot/shared` `IHaltChangedEvent` 1:1 (M9 R1 adjudication B —
// `wasAlreadyHalted` field added so consumers can distinguish a real state
// transition from an operator re-affirmation of the existing state).
export interface IHaltChangedEvent {
    readonly action: 'HALT' | 'RESUME';
    readonly state: HaltStateEnum;
    readonly source: HaltSourceEnum;
    readonly reason: string;
    readonly auditId: string;
    readonly occurredAt: string;
    readonly wasAlreadyHalted: boolean;
}
