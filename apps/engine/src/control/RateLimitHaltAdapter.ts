import { HaltSourceEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { HaltFlagService } from '../common/service/HaltFlagService';
import { IRateLimitHaltAutoClearParams, IRateLimitHaltEngageParams, IRateLimitHaltPort } from '../exchange/interface/IRateLimitHaltPort';
import { ControlAuditRepository } from './repository/ControlAuditRepository';
import { HaltService } from './HaltService';

// M11a W1.4 (ADR 0030 §2.6.2).
//
// Adapter that fulfils IRateLimitHaltPort from the exchange module. Lives in
// ControlModule so the cycle-free direction (exchange exposes the port token;
// control supplies the impl) is preserved.
//
// Engage path mirrors the existing programmatic-halt flow used by
// `RiskListeners.engageProgrammatic` for market-stress / model-divergence:
//   1. Flip the in-memory M0 halt flag (so the M5 executor refuses
//      exposure-increasing intents in the same tick).
//   2. Write a `control_audit` row via `appendProgrammatic` (source=RATE_LIMIT
//      preserves precise audit attribution; the M4 SoT `risk_state.is_halted`
//      is not touched — rate-limit halts are exchange-bound, not risk-window-
//      bound).
//   3. Notify `HaltService.notePragmaticTransition` so the `/v1/control/halt`
//      read renders `haltSource=RATE_LIMIT` + the engage `occurredAt`.
//
// Auto-clear path runs at freeze expiry without a further 429/418:
//   1. Skip if the flag's current reason is not our `RATE_LIMIT:*` prefix —
//      another halt source (operator, market-stress, model-divergence) may
//      have engaged during the freeze window and must NOT be cleared by us.
//   2. Otherwise resume the flag, write a `RATE_LIMIT_HALT_AUTO_CLEARED`
//      audit row, and notify `HaltService` of the synthetic RUNNING
//      transition.
//
// Both methods are non-throwing: a DB outage at engage time must not block
// the bucket-freeze from taking effect; an outage at auto-clear time leaves
// the flag halted (safer than letting the executor resume while the audit
// row is missing).
@Injectable()
export class RateLimitHaltAdapter implements IRateLimitHaltPort {
    private readonly logger = new Logger(RateLimitHaltAdapter.name);

    constructor(
        private readonly haltFlag: HaltFlagService,
        private readonly auditRepo: ControlAuditRepository,
        private readonly haltService: HaltService,
    ) {}

    async engage(params: IRateLimitHaltEngageParams): Promise<void> {
        const reasonText = this.formatReason(params.reason);
        const previousState = this.haltFlag.isHalted() ? 'HALTED' : 'RUNNING';

        try {
            if (!this.haltFlag.isHalted()) {
                this.haltFlag.halt(`${HaltSourceEnum.RATE_LIMIT}:${params.reason}`);
            }
        } catch (cause) {
            this.logger.error(`rateLimitHalt.engage.flag.failed cause=${describe(cause)}`);
        }

        try {
            this.haltService.notePragmaticTransition(HaltSourceEnum.RATE_LIMIT, params.reason, params.occurredAt.getTime());
        } catch (cause) {
            this.logger.error(`rateLimitHalt.engage.note.failed cause=${describe(cause)}`);
        }

        try {
            await this.auditRepo.appendProgrammatic({
                occurredAt: params.occurredAt,
                source: HaltSourceEnum.RATE_LIMIT,
                correlationEventId: null,
                reason: reasonText,
                flattenRequested: false,
                previousState,
                newState: 'HALTED',
            });
        } catch (cause) {
            this.logger.error(`rateLimitHalt.engage.audit.failed cause=${describe(cause)}`);
        }
    }

    async autoClear(params: IRateLimitHaltAutoClearParams): Promise<void> {
        if (!this.isOwnedByRateLimit()) {
            this.logger.warn('rateLimitHalt.autoClear.skipped — flag reason is not RATE_LIMIT; another halt engaged during freeze window');

            return;
        }

        try {
            this.haltFlag.resume();
        } catch (cause) {
            this.logger.error(`rateLimitHalt.autoClear.flag.failed cause=${describe(cause)}`);
        }

        try {
            this.haltService.notePragmaticAutoClear(HaltSourceEnum.RATE_LIMIT, params.reason, params.occurredAt.getTime());
        } catch (cause) {
            this.logger.error(`rateLimitHalt.autoClear.note.failed cause=${describe(cause)}`);
        }

        try {
            await this.auditRepo.appendRateLimitAutoCleared({
                occurredAt: params.occurredAt,
                reason: params.reason,
                correlationEventId: null,
            });
        } catch (cause) {
            this.logger.error(`rateLimitHalt.autoClear.audit.failed cause=${describe(cause)}`);
        }
    }

    private formatReason(detail: string): string {
        return `RATE_LIMIT_BAN:${detail}`;
    }

    private isOwnedByRateLimit(): boolean {
        const reason = this.haltFlag.getReason();

        if (reason === null) {
            return false;
        }

        return reason.startsWith(`${HaltSourceEnum.RATE_LIMIT}:`);
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
