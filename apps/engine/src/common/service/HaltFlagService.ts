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

    isHalted(): boolean {
        return this.halted;
    }

    getReason(): string | null {
        return this.reason;
    }

    halt(reason: string): void {
        this.halted = true;
        this.reason = reason;
        this.logger.warn(`Trading halted: ${reason}`);
    }

    resume(): void {
        this.halted = false;
        this.reason = null;
        this.logger.warn('Trading resumed');
    }
}
