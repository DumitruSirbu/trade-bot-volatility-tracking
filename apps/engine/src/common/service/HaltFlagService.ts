import { RejectReasonEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

// Process-wide kill-switch backing state. Default OFF. M9 builds the HTTP
// endpoint on top of this; M6's execution path reads isHalted() before placing
// any order and records a kill_switch exit reason when set. Kept deliberately
// simple — a single in-memory flag with a reason — until those milestones land.
@Injectable()
export class HaltFlagService {
    private readonly logger = new Logger(HaltFlagService.name);

    private halted = false;

    private reason: string | null = null;

    // M23 (ADR 0004 §6d). The bare trigger-leg token (e.g. `breadth`) parsed from a
    // `market_stress:<leg>` reason — NOT the full reason string. Null for non-market_stress
    // halts. Lets a getHaltedLeg() query report the leg without re-parsing at every read.
    private marketStressLeg: string | null = null;

    isHalted(): boolean {
        return this.halted;
    }

    getReason(): string | null {
        return this.reason;
    }

    // M23 (ADR 0004 §6d). The bare leg token of the current in-memory halt (e.g. `breadth`),
    // never the full `market_stress:breadth` reason. Null when not halted or the halt carries
    // no market_stress leg suffix.
    getHaltedLeg(): string | null {
        return this.marketStressLeg;
    }

    halt(reason: string): void {
        this.halted = true;
        this.reason = reason;
        this.marketStressLeg = parseMarketStressLeg(reason);
        this.logger.warn(`Trading halted: ${reason}`);
    }

    resume(): void {
        this.halted = false;
        this.reason = null;
        this.marketStressLeg = null;
        this.logger.warn('Trading resumed');
    }
}

// Extract the bare leg token from a `market_stress:<leg>` reason. Returns null for a bare
// `market_stress` (no suffix), a non-market_stress reason, or an empty suffix.
function parseMarketStressLeg(reason: string): string | null {
    const prefix = `${RejectReasonEnum.MARKET_STRESS}:`;

    if (!reason.startsWith(prefix)) {
        return null;
    }

    const leg = reason.slice(prefix.length);

    return leg.length > 0 ? leg : null;
}
