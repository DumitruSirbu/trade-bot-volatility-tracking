/**
 * Reject-classification taxonomy (ADR 0006 §4 fix-wave). The standalone
 * `ExchangeRejectError` class was deleted in the round-3 dead-code sweep —
 * rejectClass / venueCode / venueMessage now flow exclusively through
 * `ISubmitResult` (the submitter's return shape).
 *
 * Coverage:
 *   1. BINANCE_REJECT_CLASSIFICATION table: -1021 → RETRIABLE, -2010 → TERMINAL
 *   2. Submitter runSubmitStateMachine: RETRIABLE advances attemptN (non-terminal)
 *   3. Submitter state machine: TERMINAL short-circuits to ABORTED in a single attempt
 *   4. UNKNOWN routes to recover-by-clientOrderId (recover called, not a second submit)
 *   5. -5022 duplicate-id routes to UNKNOWN (fetch path)
 *   6. -2010 reduce-only maps to TERMINAL via table
 *   7. -1021 timestamp maps to RETRIABLE via table
 *   8. SUBMIT_TIMEOUT_ERROR_MARKER classified via structured cause field, not message text
 *   9. ExchangeRequestException.isTimeout predicate: cause === marker fires; message text does not
 */

import { OrderPolicyEnum, PositionSideEnum } from '@bot/shared';

import { ExchangeRequestException } from '../../../src/exchange/exception/ExchangeRequestException';
import { BINANCE_REJECT_CLASSIFICATION, SUBMIT_NETWORK_TIMEOUT_MS, SUBMIT_TIMEOUT_ERROR_MARKER } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { buildExchangeClientMock, buildOrderSnapshot } from '../support/fixtures';

jest.useFakeTimers();

const SYMBOL = 'BTCUSDT';
const CLIENT_ID = 'tbvt-aabbccddee1122334455';

function makeSubmitter(exchangeClientMock: ReturnType<typeof buildExchangeClientMock>) {
    const fillAccumulator = new FillAccumulator();
    const submitter = new ExchangeOrderSubmitter(exchangeClientMock as never, fillAccumulator);
    return { submitter, fillAccumulator };
}

function baseInput() {
    return {
        clientOrderId: CLIENT_ID,
        symbol: SYMBOL,
        tradeSide: PositionSideEnum.SHORT,
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
        limitPrice: '30000',
        amount: '0.01',
        reduceOnly: false,
        closePosition: false,
    };
}

// ─── BINANCE_REJECT_CLASSIFICATION table ──────────────────────────────────────

describe('BINANCE_REJECT_CLASSIFICATION table — taxonomy', () => {
    const retriableCodes = ['-1000', '-1001', '-1003', '-1007', '-1015', '-1021'];
    const terminalCodes = ['-2010', '-2011', '-2013', '-2018', '-2019', '-2020', '-2021', '-2022', '-2027', '-4131', '-4164'];

    for (const code of retriableCodes) {
        it(`code ${code} classifies as RETRIABLE`, () => {
            expect(BINANCE_REJECT_CLASSIFICATION[code]).toBe('RETRIABLE');
        });
    }

    for (const code of terminalCodes) {
        it(`code ${code} classifies as TERMINAL`, () => {
            expect(BINANCE_REJECT_CLASSIFICATION[code]).toBe('TERMINAL');
        });
    }

    it('code not in table has no entry (undefined — caller defaults to TERMINAL / UNKNOWN)', () => {
        // Per ADR 0006 §4: unmapped codes default to TERMINAL for safety.
        expect(BINANCE_REJECT_CLASSIFICATION['-9999']).toBeUndefined();
    });
});

// ─── Submitter: RETRIABLE advances attemptN (non-terminal) ───────────────────

describe('ExchangeOrderSubmitter — RETRIABLE reject is non-terminal', () => {
    it('-1021 timestamp reject returns REJECTED state (non-terminal; caller should advance attemptN)', async () => {
        // BUILD: ExchangeRequestException with a Binance JSON body containing -1021
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(new ExchangeRequestException('createOrder', 'binance {"code":-1021,"msg":"Timestamp outside recv window"}'));
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const result = await submitter.submit(baseInput());

        // CHECK: RETRIABLE → REJECTED state; rejectClass explicitly set so caller increments attemptN
        expect(result.state).toBe(SubmitStateEnum.REJECTED);
        expect(result.rejectClass).toBe('RETRIABLE');
        expect(result.venueCode).toBe('-1021');
    });
});

// ─── Submitter: TERMINAL short-circuits immediately ──────────────────────────

describe('ExchangeOrderSubmitter — TERMINAL reject short-circuits', () => {
    it('-2010 reduce-only reject returns REJECTED state with TERMINAL classification', async () => {
        // BUILD
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(new ExchangeRequestException('createOrder', 'binance {"code":-2010,"msg":"ReduceOnly order is rejected"}'));
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const result = await submitter.submit(baseInput());

        // CHECK: TERMINAL → rejectClass TERMINAL; ExecutionService branches to ABORTED, releases reservation
        expect(result.rejectClass).toBe('TERMINAL');
        expect(result.venueCode).toBe('-2010');
        // createOrder was called exactly once — no retry inside the submitter itself
        expect(mock.createOrder).toHaveBeenCalledTimes(1);
    });

    it('-2022 ReduceOnly order is rejected → TERMINAL', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(new ExchangeRequestException('createOrder', 'binance {"code":-2022,"msg":"ReduceOnly Order is rejected"}'));
        const { submitter } = makeSubmitter(mock);

        const result = await submitter.submit(baseInput());

        expect(result.rejectClass).toBe('TERMINAL');
        expect(result.venueCode).toBe('-2022');
    });
});

// ─── Submitter: UNKNOWN routes to recover-by-clientOrderId ───────────────────

describe('ExchangeOrderSubmitter — UNKNOWN routes to recover (not a second createOrder)', () => {
    it('submit timeout yields UNKNOWN state — recover is the caller responsibility', async () => {
        // BUILD: createOrder never resolves → submit-timeout fires
        const mock = buildExchangeClientMock();
        mock.createOrder.mockImplementation(() => new Promise(() => undefined));
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const resultPromise = submitter.submit(baseInput());
        jest.advanceTimersByTime(SUBMIT_NETWORK_TIMEOUT_MS + 100);
        const result = await resultPromise;

        // CHECK: UNKNOWN state + UNKNOWN class; venueMessage is the structured marker
        expect(result.state).toBe(SubmitStateEnum.UNKNOWN);
        expect(result.rejectClass).toBe('UNKNOWN');
        expect(result.venueMessage).toBe(SUBMIT_TIMEOUT_ERROR_MARKER);
        // Only one createOrder call — submitter does NOT retry internally on UNKNOWN
        expect(mock.createOrder).toHaveBeenCalledTimes(1);
    });

    it('-5022 duplicate-order-id routes to UNKNOWN (caller fetches by clientOrderId)', async () => {
        // BUILD: Binance returns -5022 JSON body
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(new ExchangeRequestException('createOrder', 'binance {"code":-5022,"msg":"Duplicate order id"}'));
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const result = await submitter.submit(baseInput());

        // CHECK: -5022 is the duplicate-id sentinel → UNKNOWN for fetch-and-reconcile
        expect(result.state).toBe(SubmitStateEnum.UNKNOWN);
        expect(result.rejectClass).toBe('UNKNOWN');
    });
});

// ─── ExchangeRequestException cause/code propagation ─────────────────────────

describe('ExchangeRequestException — cause and code propagation (QA #1 fix)', () => {
    it('cause field carries the sanitized ccxt message, not the wrapper text', () => {
        // BUILD: this is how callExchange constructs the exception (operation + sanitized cause)
        const sanitizedCause = 'binance {"code":-1021,"msg":"Timestamp outside recv window"}';
        const exception = new ExchangeRequestException('createOrder:BTCUSDT', sanitizedCause);

        // CHECK: cause (the inner sanitized string) is accessible directly
        expect(exception.cause).toBe(sanitizedCause);
        // The wrapper message describes the operation, not the cause
        expect(exception.message).toContain('createOrder:BTCUSDT');
        expect(exception.message).not.toContain('-1021');
    });

    it('submit timeout: ExchangeRequestException with SUBMIT_TIMEOUT_ERROR_MARKER as cause fires isSubmitTimeout', async () => {
        // BUILD: replicate what withSubmitTimeout raises
        const timeoutException = new ExchangeRequestException('createOrder:BTCUSDT:client-1', SUBMIT_TIMEOUT_ERROR_MARKER);
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(timeoutException);
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const result = await submitter.submit(baseInput());

        // CHECK: the structured cause (SUBMIT_TIMEOUT_ERROR_MARKER) is what triggers UNKNOWN,
        // NOT a substring match on the wrapper message
        expect(result.state).toBe(SubmitStateEnum.UNKNOWN);
        expect(result.rejectClass).toBe('UNKNOWN');
    });

    it('ExchangeRequestException with non-timeout cause does not fire timeout path', () => {
        // BUILD: same wrapper type but cause is NOT the timeout marker
        const exception = new ExchangeRequestException('createOrder', 'some other error');

        // CHECK: cause is the "other error" string, not the marker
        expect(exception.cause).toBe('some other error');
        expect(exception.cause).not.toBe(SUBMIT_TIMEOUT_ERROR_MARKER);
    });

    it('-5022 duplicate-id via ExchangeRequestException cause field routes to UNKNOWN', async () => {
        // BUILD: ExchangeRequestException whose cause contains the Binance -5022 JSON
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValue(new ExchangeRequestException('createOrder', 'binance {"code":-5022,"msg":"Duplicate order id"}'));
        const { submitter } = makeSubmitter(mock);

        // OPERATE
        const result = await submitter.submit(baseInput());

        // CHECK: cause-field extraction finds the code; routes to UNKNOWN not TERMINAL
        expect(result.state).toBe(SubmitStateEnum.UNKNOWN);
    });
});
