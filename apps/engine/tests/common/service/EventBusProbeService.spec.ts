import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { EventBusProbeService } from '../../../src/common/service/EventBusProbeService';

async function buildModule(): Promise<TestingModule> {
    return Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [EventBusProbeService],
    }).compile();
}

describe('EventBusProbeService', () => {
    let module: TestingModule;
    let service: EventBusProbeService;

    beforeEach(async () => {
        module = await buildModule();
        // init() triggers NestJS lifecycle hooks including @OnEvent decoration
        await module.init();
        service = module.get(EventBusProbeService);
    });

    afterEach(async () => {
        await module.close();
    });

    it('hasReceived returns false for a ping that has not been emitted', () => {
        expect(service.hasReceived('unknown-id')).toBe(false);
    });

    it('emitting a ping causes the handler to mark that ping as received', () => {
        service.emitPing('ping-001');

        expect(service.hasReceived('ping-001')).toBe(true);
    });

    it('hasReceived returns false for a different ping id after an unrelated emit', () => {
        service.emitPing('ping-001');

        expect(service.hasReceived('ping-002')).toBe(false);
    });

    it('tracks each unique ping id independently', () => {
        service.emitPing('alpha');
        service.emitPing('beta');

        expect(service.hasReceived('alpha')).toBe(true);
        expect(service.hasReceived('beta')).toBe(true);
    });

    it('emitting the same ping id twice does not throw and is idempotently received', () => {
        service.emitPing('dup-id');
        service.emitPing('dup-id');

        expect(service.hasReceived('dup-id')).toBe(true);
    });
});
