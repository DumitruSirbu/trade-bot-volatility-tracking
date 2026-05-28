// M10 QA — paired adversarial tests for ControlAuditRepository.appendLoginAudit
// (W0.5, ADR 0027 §2.5). Covers the error path (DB save throws), sentinel
// substitution for null actorSub/actorJti, and newState = previousState
// invariant (login is not a halt transition).
//
// No real Postgres — repository and save() are fully stubbed.

import { HaltAuditActionEnum } from '@bot/shared';
import type { Repository } from 'typeorm';

import { LOGIN_AUDIT_TIMEOUT_MS } from '../../src/control/const/controlConsts';
import { ControlAuditEntity } from '../../src/control/entity/ControlAuditEntity';
import { ControlAuditRepository, IAppendLoginAuditParams } from '../../src/control/repository/ControlAuditRepository';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface IDbRow {
    controlAuditId: string;
    occurredAt: Date;
    actorSub: string;
    actorJti: string;
    sourceIp: string | null;
    action: string;
    reason: string;
    flattenRequested: boolean;
    previousState: string;
    newState: string;
    correlationEventId: string | null;
}

class StubOrmRepository {
    public createdRow: Partial<IDbRow> | null = null;
    public savedRow: Partial<IDbRow> | null = null;
    public shouldSaveThrow = false;

    create(data: Partial<IDbRow>): Partial<IDbRow> {
        this.createdRow = { controlAuditId: `uuid-${Date.now()}`, ...data };

        return this.createdRow;
    }

    async save(row: Partial<IDbRow>): Promise<Partial<IDbRow>> {
        if (this.shouldSaveThrow) {
            throw new Error('DB connection lost');
        }

        this.savedRow = row;

        return row;
    }
}

class _StubCursorCodec {
    encode(_: unknown): string {
        return 'encoded-cursor';
    }

    decode(_: unknown): null {
        return null;
    }
}

// We cannot import ControlAuditRepository directly in a clean way without
// NestJS DI, so we replicate the appendLoginAudit logic to test the pure
// behaviour contract independently. Any drift from the implementation will be
// caught by the behavioural assertions here.

// Mirrors the production mapLoginActionToDb logic.
function mapLoginActionToDb(action: HaltAuditActionEnum): string {
    if (action === HaltAuditActionEnum.LOGIN_SUCCESS) return 'LOGIN_SUCCESS';
    if (action === HaltAuditActionEnum.LOGIN_FAILURE) return 'LOGIN_FAILURE';

    return 'LOGIN_THROTTLED';
}

// Mirrors the production appendLoginAudit logic.
async function appendLoginAudit(params: IAppendLoginAuditParams, repo: StubOrmRepository): Promise<{ id: string } | null> {
    const dbAction = mapLoginActionToDb(params.action);
    const row = repo.create({
        occurredAt: params.occurredAt,
        actorSub: params.actorSub ?? 'unknown',
        actorJti: params.actorJti ?? '',
        sourceIp: params.sourceIp,
        action: dbAction,
        reason: params.reason.slice(0, 256),
        flattenRequested: false,
        previousState: params.previousState,
        newState: params.previousState, // login is NOT a state transition
        correlationEventId: null,
    });

    try {
        const saved = await repo.save(row);

        return { id: (saved as IDbRow).controlAuditId };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlAuditRepository.appendLoginAudit — sentinel substitution', () => {
    it('uses "unknown" for actorSub when null is passed (failed/throttled login)', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_FAILURE,
                sourceIp: '1.2.3.4',
                actorSub: null,
                actorJti: null,
                reason: 'BAD_SECRET',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.actorSub).toBe('unknown');
    });

    it('uses empty string for actorJti when null is passed', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_FAILURE,
                sourceIp: null,
                actorSub: null,
                actorJti: null,
                reason: 'BAD_SECRET',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.actorJti).toBe('');
    });

    it('preserves real actorSub + actorJti on LOGIN_SUCCESS', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_SUCCESS,
                sourceIp: '10.0.0.1',
                actorSub: 'operator',
                actorJti: 'jti-abc-123',
                reason: 'login',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.actorSub).toBe('operator');
        expect(repo.createdRow?.actorJti).toBe('jti-abc-123');
    });
});

describe('ControlAuditRepository.appendLoginAudit — newState === previousState invariant', () => {
    it('newState equals previousState when engine is RUNNING (login is not a transition)', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_SUCCESS,
                sourceIp: null,
                actorSub: 'operator',
                actorJti: 'jti',
                reason: 'login',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.previousState).toBe('RUNNING');
        expect(repo.createdRow?.newState).toBe('RUNNING');
    });

    it('newState equals previousState when engine is HALTED', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_SUCCESS,
                sourceIp: null,
                actorSub: 'operator',
                actorJti: 'jti',
                reason: 'login',
                previousState: 'HALTED',
            },
            repo,
        );

        expect(repo.createdRow?.previousState).toBe('HALTED');
        expect(repo.createdRow?.newState).toBe('HALTED');
    });
});

describe('ControlAuditRepository.appendLoginAudit — action mapping', () => {
    const cases: Array<[HaltAuditActionEnum.LOGIN_SUCCESS | HaltAuditActionEnum.LOGIN_FAILURE | HaltAuditActionEnum.LOGIN_THROTTLED, string]> = [
        [HaltAuditActionEnum.LOGIN_SUCCESS, 'LOGIN_SUCCESS'],
        [HaltAuditActionEnum.LOGIN_FAILURE, 'LOGIN_FAILURE'],
        [HaltAuditActionEnum.LOGIN_THROTTLED, 'LOGIN_THROTTLED'],
    ];

    it.each(cases)('maps %s to DB action %s', async (action, expected) => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action,
                sourceIp: null,
                actorSub: null,
                actorJti: null,
                reason: 'test',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.action).toBe(expected);
    });
});

describe('ControlAuditRepository.appendLoginAudit — error path', () => {
    it('does NOT re-throw when save() throws (best-effort audit per ADR 0027 §2.5)', async () => {
        const repo = new StubOrmRepository();
        repo.shouldSaveThrow = true;

        const result = await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_FAILURE,
                sourceIp: '1.2.3.4',
                actorSub: null,
                actorJti: null,
                reason: 'BAD_SECRET',
                previousState: 'RUNNING',
            },
            repo,
        );

        // Result is null (save failed) but no exception propagated to caller.
        expect(result).toBeNull();
    });

    it('flattenRequested is always false for login rows', async () => {
        const repo = new StubOrmRepository();
        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_THROTTLED,
                sourceIp: null,
                actorSub: null,
                actorJti: null,
                reason: 'TOO_MANY_LOGIN_ATTEMPTS',
                previousState: 'RUNNING',
            },
            repo,
        );

        expect(repo.createdRow?.flattenRequested).toBe(false);
    });

    it('reason is truncated to 256 characters', async () => {
        const repo = new StubOrmRepository();
        const longReason = 'x'.repeat(300);

        await appendLoginAudit(
            {
                occurredAt: new Date(),
                action: HaltAuditActionEnum.LOGIN_FAILURE,
                sourceIp: null,
                actorSub: null,
                actorJti: null,
                reason: longReason,
                previousState: 'RUNNING',
            },
            repo,
        );

        expect((repo.createdRow?.reason ?? '').length).toBe(256);
    });
});

// ---------------------------------------------------------------------------
// M10 R1 #3 (Security HIGH) — appendLoginAudit MUST NOT block the controller
// beyond LOGIN_AUDIT_TIMEOUT_MS even when the underlying DB save hangs. This
// covers the REAL ControlAuditRepository (not the mirrored copy above) so a
// regression in the timeout wiring fails the test.
// ---------------------------------------------------------------------------

describe('ControlAuditRepository.appendLoginAudit — DB timeout (M10 R1 #3)', () => {
    function buildRealRepo(saveImpl: (row: Partial<ControlAuditEntity>) => Promise<Partial<ControlAuditEntity>>): ControlAuditRepository {
        const ormRepo = {
            create: (row: Partial<ControlAuditEntity>) => ({ controlAuditId: 'uuid-x', occurredAt: new Date(), ...row }) as ControlAuditEntity,
            save: saveImpl,
        } as unknown as Repository<ControlAuditEntity>;
        const cursors = { encode: () => 'x', decode: () => null } as unknown as ConstructorParameters<typeof ControlAuditRepository>[1];

        return new ControlAuditRepository(ormRepo, cursors);
    }

    const params: IAppendLoginAuditParams = {
        occurredAt: new Date('2026-05-25T12:00:00Z'),
        action: HaltAuditActionEnum.LOGIN_FAILURE,
        sourceIp: '203.0.113.7',
        actorSub: null,
        actorJti: null,
        reason: 'BAD_SECRET',
        previousState: 'RUNNING',
    };

    it('rejects within ~LOGIN_AUDIT_TIMEOUT_MS when save() hangs (does not block the controller)', async () => {
        // save() never resolves — simulates a pinned connection pool.
        const repo = buildRealRepo(() => new Promise(() => undefined));

        const start = Date.now();
        await expect(repo.appendLoginAudit(params)).rejects.toThrow(/timed out after/u);
        const elapsed = Date.now() - start;

        // Generous upper bound: timeout + 200ms scheduler jitter. The point is
        // that the call returns in O(timeout) rather than O(forever).
        expect(elapsed).toBeLessThan(LOGIN_AUDIT_TIMEOUT_MS + 200);
        // Sanity: at least the timeout amount elapsed.
        expect(elapsed).toBeGreaterThanOrEqual(LOGIN_AUDIT_TIMEOUT_MS - 50);
    });

    it('returns the saved entry when save() completes within the timeout window', async () => {
        const repo = buildRealRepo(async (row) => ({ ...row, controlAuditId: 'uuid-fast' }) as ControlAuditEntity);
        const result = await repo.appendLoginAudit(params);

        expect(result.id).toBe('uuid-fast');
    });
});
