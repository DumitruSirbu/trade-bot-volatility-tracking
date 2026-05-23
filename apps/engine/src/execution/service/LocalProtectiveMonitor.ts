import { Injectable, Logger } from '@nestjs/common';

import { MoneyValue } from '../../common/utils/money';

// In-memory arm/disarm seam owned by M5 (ADR 0008 §2). The full price-driven evaluation
// loop is M6's concern; M5 ships ONLY the seam so the position is structurally protected
// from tick #1: `arm` is called SYNCHRONOUSLY between `positions.insert` and the
// exchange-side protective-attach call, REGARDLESS of attach outcome. Exchange-side
// success then disarms via a separate call; attach failure leaves the position armed,
// so the local layer keeps watching by default (Round-1 must-fix #13).
//
// Arming is a constant-time map insert: it cannot fail, never awaits I/O, and is
// observable for tests. The actual evaluation loop and the close-intent emission path
// land in M6.

interface IArmedPosition {
    readonly positionId: number;
    readonly symbol: string;
    readonly stopLossPrice: MoneyValue;
    readonly takeProfitPrice: MoneyValue;
    readonly armedAtMs: number;
}

@Injectable()
export class LocalProtectiveMonitor {
    private readonly logger = new Logger(LocalProtectiveMonitor.name);

    private readonly armed = new Map<number, IArmedPosition>();

    arm(input: { positionId: number; symbol: string; stopLossPrice: MoneyValue; takeProfitPrice: MoneyValue }): void {
        this.armed.set(input.positionId, {
            positionId: input.positionId,
            symbol: input.symbol,
            stopLossPrice: input.stopLossPrice,
            takeProfitPrice: input.takeProfitPrice,
            armedAtMs: Date.now(),
        });

        this.logger.log(`local monitor armed positionId=${input.positionId} symbol=${input.symbol}`);
    }

    disarm(positionId: number): void {
        if (!this.armed.has(positionId)) {
            return;
        }

        this.armed.delete(positionId);
        this.logger.log(`local monitor disarmed positionId=${positionId}`);
    }

    isArmed(positionId: number): boolean {
        return this.armed.has(positionId);
    }

    // Exposed for M6's evaluation loop (next milestone). M5 only writes the map; M6 reads.
    listArmed(): readonly IArmedPosition[] {
        return [...this.armed.values()];
    }
}
