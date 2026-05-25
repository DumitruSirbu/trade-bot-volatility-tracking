// M10 QA — adversarial tests for liveSocket.ts (W3).
//
// Coverage: single connection per token (no duplicate sockets on same token);
// new socket created on token change; old socket disconnected before new one;
// null token disconnects without creating a new socket; subscriber callbacks
// fired on change; cleanup via returned unsubscribe function.
//
// socket.io-client is fully mocked — no real network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock socket.io-client before importing the module under test.
// ---------------------------------------------------------------------------

const mockDisconnect = vi.fn();
const mockOn = vi.fn();
const mockEmit = vi.fn();

// Each call to io() returns a new mock socket instance with fresh spy references.
let ioCallCount = 0;
const mockIo = vi.fn((_path: string, _opts: Record<string, unknown>) => {
    ioCallCount += 1;

    return {
        disconnect: mockDisconnect,
        on: mockOn,
        emit: mockEmit,
        io: { on: vi.fn() },
        _callNumber: ioCallCount,
    };
});

vi.mock('socket.io-client', () => ({
    io: (path: string, opts: Record<string, unknown>) => mockIo(path, opts),
}));

// Import AFTER mock is registered.
import { setSocketToken, getSocket, onSocketChange } from './liveSocket';

// ---------------------------------------------------------------------------
// Reset module state between tests via the reset() shim. The module uses
// module-level variables (currentSocket, currentToken); we need a clean slate.
// ---------------------------------------------------------------------------

// Helper: reset module-level state by cycling through null token.
function resetModule(): void {
    setSocketToken(null);
    mockIo.mockClear();
    mockDisconnect.mockClear();
    mockOn.mockClear();
    mockEmit.mockClear();
    ioCallCount = 0;
}

beforeEach(() => {
    resetModule();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('liveSocket — single connection per token', () => {
    it('creates one socket when a token is set', () => {
        setSocketToken('token-a');
        expect(mockIo).toHaveBeenCalledTimes(1);
    });

    it('does NOT recreate the socket when setSocketToken is called with the same token again', () => {
        setSocketToken('token-a');
        setSocketToken('token-a'); // same value → no-op
        expect(mockIo).toHaveBeenCalledTimes(1);
    });
});

describe('liveSocket — token change creates a new socket', () => {
    it('disconnects the old socket and creates a new one when the token changes', () => {
        setSocketToken('token-a');
        expect(mockIo).toHaveBeenCalledTimes(1);

        setSocketToken('token-b');

        // Old socket must be disconnected.
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        // A new socket must be created.
        expect(mockIo).toHaveBeenCalledTimes(2);
    });

    it('passes the new token in the auth field', () => {
        setSocketToken('token-alpha');

        const [[namespacePath, opts]] = mockIo.mock.calls as unknown as [[string, { auth: { token: string } }]];
        expect(namespacePath).toBe('/live');
        expect(opts.auth.token).toBe('token-alpha');
    });
});

describe('liveSocket — null token disconnects without creating a socket', () => {
    it('disconnects existing socket when set to null', () => {
        setSocketToken('token-a');
        setSocketToken(null);

        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        expect(getSocket()).toBeNull();
    });

    it('does not call io() when set to null with no existing socket', () => {
        setSocketToken(null);
        expect(mockIo).not.toHaveBeenCalled();
    });

    it('setting null again (already null) is a no-op', () => {
        setSocketToken(null);
        setSocketToken(null); // second null
        expect(mockDisconnect).not.toHaveBeenCalled();
        expect(mockIo).not.toHaveBeenCalled();
    });
});

describe('liveSocket — subscriber callbacks', () => {
    it('immediately calls the subscriber with the current socket on registration', () => {
        setSocketToken('token-a');
        const socket = getSocket();

        const cb = vi.fn();
        const unsubscribe = onSocketChange(cb);

        // Called immediately with the current socket.
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(socket);

        unsubscribe();
    });

    it('immediately calls the subscriber with null when no socket exists', () => {
        // null state (reset above).
        const cb = vi.fn();
        const unsubscribe = onSocketChange(cb);

        expect(cb).toHaveBeenCalledWith(null);
        unsubscribe();
    });

    it('notifies all subscribers when the token changes', () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();

        const unsub1 = onSocketChange(cb1);
        const unsub2 = onSocketChange(cb2);

        // Clear the immediate-call invocations.
        cb1.mockClear();
        cb2.mockClear();

        setSocketToken('token-new');

        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(1);

        unsub1();
        unsub2();
    });

    it('stops notifying after unsubscribe', () => {
        const cb = vi.fn();
        const unsubscribe = onSocketChange(cb);
        cb.mockClear();

        unsubscribe();

        setSocketToken('token-after-unsub');

        expect(cb).not.toHaveBeenCalled();
    });
});

describe('liveSocket — getSocket', () => {
    it('returns the active socket after setSocketToken', () => {
        setSocketToken('token-xyz');
        const socket = getSocket();
        expect(socket).not.toBeNull();
    });

    it('returns null before any token is set', () => {
        expect(getSocket()).toBeNull();
    });

    it('returns null after token is cleared', () => {
        setSocketToken('token-xyz');
        setSocketToken(null);
        expect(getSocket()).toBeNull();
    });
});
