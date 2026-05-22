import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { HEALTH_PING_EVENT } from '../const';
import { IHealthPingEvent } from '../interface';

// Proves the @nestjs/event-emitter bus is wired end to end: emitPing() fires an
// event that handlePing() receives in-process. Real domain events replace this
// in later milestones; QA exercises the round-trip against this service.
@Injectable()
export class EventBusProbeService {
    private readonly logger = new Logger(EventBusProbeService.name);

    private readonly receivedPingIds = new Set<string>();

    constructor(private readonly eventEmitter: EventEmitter2) {}

    emitPing(pingId: string): void {
        const event: IHealthPingEvent = { pingId };
        this.eventEmitter.emit(HEALTH_PING_EVENT, event);
    }

    hasReceived(pingId: string): boolean {
        return this.receivedPingIds.has(pingId);
    }

    @OnEvent(HEALTH_PING_EVENT)
    handlePing(event: IHealthPingEvent): void {
        this.receivedPingIds.add(event.pingId);
        this.logger.debug(`Event bus round-trip confirmed for ping ${event.pingId}`);
    }
}
