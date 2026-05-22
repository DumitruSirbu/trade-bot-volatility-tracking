import { HaltFlagService } from '../../../src/common/service/HaltFlagService';

function buildService(): HaltFlagService {
    return new HaltFlagService();
}

describe('HaltFlagService', () => {
    describe('initial state', () => {
        it('isHalted returns false before any halt is called', () => {
            const service = buildService();

            expect(service.isHalted()).toBe(false);
        });

        it('getReason returns null before any halt is called', () => {
            const service = buildService();

            expect(service.getReason()).toBeNull();
        });
    });

    describe('halt()', () => {
        it('sets isHalted to true after halt is called', () => {
            const service = buildService();

            service.halt('manual stop');

            expect(service.isHalted()).toBe(true);
        });

        it('stores the reason string after halt is called', () => {
            const service = buildService();

            service.halt('daily loss limit hit');

            expect(service.getReason()).toBe('daily loss limit hit');
        });

        it('overwrites reason when halt is called a second time', () => {
            const service = buildService();
            service.halt('first reason');

            service.halt('second reason');

            expect(service.getReason()).toBe('second reason');
            expect(service.isHalted()).toBe(true);
        });
    });

    describe('resume()', () => {
        it('sets isHalted to false after resume is called', () => {
            const service = buildService();
            service.halt('some reason');

            service.resume();

            expect(service.isHalted()).toBe(false);
        });

        it('clears reason to null after resume is called', () => {
            const service = buildService();
            service.halt('some reason');

            service.resume();

            expect(service.getReason()).toBeNull();
        });

        it('is a no-op when called on an already-running service', () => {
            const service = buildService();

            service.resume();

            expect(service.isHalted()).toBe(false);
            expect(service.getReason()).toBeNull();
        });
    });

    describe('full transition cycle', () => {
        it('transitions correctly through halt → resume → halt → resume', () => {
            const service = buildService();

            service.halt('round one');
            expect(service.isHalted()).toBe(true);
            expect(service.getReason()).toBe('round one');

            service.resume();
            expect(service.isHalted()).toBe(false);
            expect(service.getReason()).toBeNull();

            service.halt('round two');
            expect(service.isHalted()).toBe(true);
            expect(service.getReason()).toBe('round two');

            service.resume();
            expect(service.isHalted()).toBe(false);
            expect(service.getReason()).toBeNull();
        });
    });
});
