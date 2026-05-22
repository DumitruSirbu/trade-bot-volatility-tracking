import { HealthController } from '../../../src/health/controller/HealthController';

function buildController(): HealthController {
    return new HealthController();
}

describe('HealthController', () => {
    describe('checkLiveness()', () => {
        it('returns an object with status "ok"', () => {
            const controller = buildController();

            const result = controller.checkLiveness();

            expect(result).toEqual({ status: 'ok' });
        });

        it('returns exactly one key — no internal state leaks', () => {
            const controller = buildController();

            const result = controller.checkLiveness();

            expect(Object.keys(result)).toStrictEqual(['status']);
        });

        it('returns the same value on every call (stateless)', () => {
            const controller = buildController();

            const first = controller.checkLiveness();
            const second = controller.checkLiveness();

            expect(first).toEqual(second);
        });
    });
});
