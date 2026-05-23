import { OrderPolicyEnum, PositionSideEnum } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { ExchangeRejectClass, ExchangeRequestException } from '../../exchange/exception';
import { EXCHANGE_CLIENT, ICreateOrderRequest, IExchangeClient, IExchangeOrderSnapshot } from '../../exchange/interface';
import {
    BINANCE_REJECT_CLASSIFICATION,
    CCXT_ORDER_SIDE_BUY,
    CCXT_ORDER_SIDE_SELL,
    CCXT_ORDER_STATUS_CANCELED,
    CCXT_ORDER_STATUS_CLOSED,
    CCXT_ORDER_STATUS_EXPIRED,
    CCXT_ORDER_STATUS_OPEN,
    CCXT_ORDER_STATUS_REJECTED,
    CCXT_ORDER_TYPE_LIMIT,
    CCXT_ORDER_TYPE_MARKET,
    CCXT_RETRIABLE_ERROR_NAMES,
    CCXT_TERMINAL_ERROR_NAMES,
    CCXT_TIME_IN_FORCE_GTX,
    CCXT_TIME_IN_FORCE_IOC,
    MAX_UNKNOWN_RECOVERY_ATTEMPTS,
    RECOVERY_BACKOFF_MS,
    SUBMIT_NETWORK_TIMEOUT_MS,
    SUBMIT_TIMEOUT_ERROR_MARKER,
} from '../const';
import { SubmitStateEnum } from '../enum';
import { FillAccumulator } from './FillAccumulator';

// Thin wrapper around IExchangeClient that maps an IOrderPlanInternal + side + qty into the
// concrete ccxt createOrder call, applies SUBMIT_NETWORK_TIMEOUT_MS, runs the timeout-
// recovery protocol (ADR 0006 §3), and CLASSIFIES every reject per the ADR 0006 §4
// taxonomy. Callers branch on `ExchangeRejectError.rejectClass` (RETRIABLE / TERMINAL /
// UNKNOWN) — they NEVER substring-match the venue message (must-fix #1 + #8).
//
// Pure ExchangeModule consumer: it goes through the injected IExchangeClient and never
// touches ccxt directly.

// Allow-list of `params` keys callers may pass through to ccxt (must-fix #11). New keys
// are added consciously here; anything else is stripped at the boundary so a typo or
// hostile payload cannot smuggle a closeAll / positionSide / hedged-mode toggle.
const ALLOWED_EXTRA_PARAM_KEYS = ['positionSide'] as const;
type AllowedExtraParamKey = (typeof ALLOWED_EXTRA_PARAM_KEYS)[number];
export type IAllowedExtraParams = Partial<Record<AllowedExtraParamKey, string>>;

interface ISubmitInput {
    readonly clientOrderId: string;
    readonly symbol: string;
    readonly tradeSide: PositionSideEnum;
    readonly policy: OrderPolicyEnum;
    readonly limitPrice: string | null;
    readonly amount: string;
    readonly reduceOnly: boolean;
    readonly closePosition: boolean;
    readonly extraParams?: IAllowedExtraParams;
}

interface ISubmitResult {
    readonly state: SubmitStateEnum;
    readonly snapshot: IExchangeOrderSnapshot | null;
    readonly rejectClass: ExchangeRejectClass | null;
    readonly venueCode: string | null;
    readonly venueMessage: string | null;
}

@Injectable()
export class ExchangeOrderSubmitter {
    private readonly logger = new Logger(ExchangeOrderSubmitter.name);

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly fillAccumulator: FillAccumulator,
    ) {}

    async submit(input: ISubmitInput): Promise<ISubmitResult> {
        const request = this.buildCreateOrderRequest(input);

        try {
            const snapshot = await this.withSubmitTimeout(input.symbol, input.clientOrderId, () => this.exchangeClient.createOrder(request));
            this.fillAccumulator.record(snapshot);

            return { state: this.mapCcxtStatus(snapshot.status), snapshot, rejectClass: null, venueCode: null, venueMessage: null };
        } catch (cause) {
            return this.handleSubmitFailure(input, cause);
        }
    }

    // Cancel by clientOrderId — used by the per-policy awaitPolicyTimeout branch.
    async cancelByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        try {
            const snapshot = await this.exchangeClient.cancelOrderByClientId(symbol, clientOrderId);
            this.fillAccumulator.record(snapshot);

            return snapshot;
        } catch (cause) {
            this.logger.warn(`cancelByClientId ${symbol} ${clientOrderId} failed: ${this.describe(cause)}`);

            return null;
        }
    }

    // Fetch by clientOrderId — used by the timeout-recovery protocol and the IOC-policy
    // terminal-state probe (ADR 0007 §4).
    async fetchByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        const snapshot = await this.exchangeClient.fetchOrderByClientId(symbol, clientOrderId);

        if (snapshot !== null) {
            this.fillAccumulator.record(snapshot);
        }

        return snapshot;
    }

    // Defensive recovery loop for UNKNOWN outcomes (ADR 0006 §3). Returns null if every probe
    // returns OrderNotFound — caller may retry with the SAME clientOrderId (attemptN unchanged).
    // Returns the snapshot if any probe finds the order. After MAX_UNKNOWN_RECOVERY_ATTEMPTS
    // attempts, escalates with RECONCILE_REQUIRED so M6 takes over.
    async recover(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        for (let attempt = 0; attempt < MAX_UNKNOWN_RECOVERY_ATTEMPTS; attempt++) {
            await this.sleep(RECOVERY_BACKOFF_MS);

            try {
                const snapshot = await this.exchangeClient.fetchOrderByClientId(symbol, clientOrderId);

                if (snapshot !== null) {
                    this.fillAccumulator.record(snapshot);

                    return snapshot;
                }
            } catch (cause) {
                this.logger.warn(`recover probe ${attempt} ${symbol} ${clientOrderId} failed: ${this.describe(cause)}`);
            }
        }

        return null;
    }

    private buildCreateOrderRequest(input: ISubmitInput): ICreateOrderRequest {
        const orderType = this.policyOrderType(input.policy);
        const side = this.tradeSideToCcxtSide(input.tradeSide, input.reduceOnly);
        const params: Record<string, unknown> = this.sanitizeExtraParams(input.extraParams);

        if (input.reduceOnly) {
            params.reduceOnly = true;
        }

        if (input.closePosition) {
            params.closePosition = true;
        }

        const timeInForce = this.policyTimeInForce(input.policy);

        if (timeInForce !== null) {
            params.timeInForce = timeInForce;
        }

        return {
            symbol: input.symbol,
            type: orderType,
            side,
            amount: input.amount,
            price: input.limitPrice,
            clientOrderId: input.clientOrderId,
            params,
        };
    }

    // For exit/reduce, the ccxt-side is the OPPOSITE of the held tradeSide: a long position
    // closes by selling, a short closes by buying. Entry orders use the trade side directly.
    private tradeSideToCcxtSide(tradeSide: PositionSideEnum, reduceOnly: boolean): string {
        const isLong = tradeSide === PositionSideEnum.LONG;

        if (reduceOnly) {
            return isLong ? CCXT_ORDER_SIDE_SELL : CCXT_ORDER_SIDE_BUY;
        }

        return isLong ? CCXT_ORDER_SIDE_BUY : CCXT_ORDER_SIDE_SELL;
    }

    private policyOrderType(policy: OrderPolicyEnum): string {
        if (policy === OrderPolicyEnum.REDUCE_MARKET) {
            return CCXT_ORDER_TYPE_MARKET;
        }

        return CCXT_ORDER_TYPE_LIMIT;
    }

    private policyTimeInForce(policy: OrderPolicyEnum): string | null {
        if (policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC) {
            return CCXT_TIME_IN_FORCE_IOC;
        }

        if (policy === OrderPolicyEnum.POST_ONLY_MAKER) {
            return CCXT_TIME_IN_FORCE_GTX;
        }

        return null;
    }

    private mapCcxtStatus(status: string): SubmitStateEnum {
        if (status === CCXT_ORDER_STATUS_OPEN) {
            return SubmitStateEnum.OPEN;
        }

        if (status === CCXT_ORDER_STATUS_CLOSED) {
            return SubmitStateEnum.FILLED;
        }

        if (status === CCXT_ORDER_STATUS_CANCELED || status === CCXT_ORDER_STATUS_EXPIRED) {
            return SubmitStateEnum.CANCELLED;
        }

        if (status === CCXT_ORDER_STATUS_REJECTED) {
            return SubmitStateEnum.REJECTED;
        }

        return SubmitStateEnum.UNKNOWN;
    }

    private async withSubmitTimeout<T>(symbol: string, clientOrderId: string, request: () => Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                // Use the structured marker — handleSubmitFailure tests the cause via the
                // marker, NOT a substring of the wrapper message (must-fix #1).
                const timeoutError = new ExchangeRequestException(`createOrder:${symbol}:${clientOrderId}`, SUBMIT_TIMEOUT_ERROR_MARKER);
                reject(timeoutError);
            }, SUBMIT_NETWORK_TIMEOUT_MS);
        });

        try {
            return await Promise.race([request(), timeout]);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    // Classify the failure WITHOUT substring-matching the wrapper message (must-fix #1 + #8).
    // The submit-timeout sentinel is identified by the marker we raised ourselves; ccxt-
    // origin failures arrive as ExchangeRequestException carrying the sanitized cause +
    // venue code, which we map via the BINANCE_REJECT_CLASSIFICATION table.
    private handleSubmitFailure(input: ISubmitInput, cause: unknown): ISubmitResult {
        if (this.isSubmitTimeout(cause)) {
            this.logger.warn(`submit ack-timeout ${input.symbol} ${input.clientOrderId} - entering UNKNOWN`);

            return { state: SubmitStateEnum.UNKNOWN, snapshot: null, rejectClass: 'UNKNOWN', venueCode: null, venueMessage: SUBMIT_TIMEOUT_ERROR_MARKER };
        }

        const venueCode = this.extractVenueCode(cause);
        const venueMessage = this.extractVenueMessage(cause);

        if (this.isDuplicateIdReject(venueCode)) {
            this.logger.warn(`duplicate-id reject ${input.clientOrderId} - exchange already has it, will reconcile via fetch`);

            return { state: SubmitStateEnum.UNKNOWN, snapshot: null, rejectClass: 'UNKNOWN', venueCode, venueMessage };
        }

        const rejectClass = this.classifyReject(cause, venueCode);

        this.logger.error(`submit ${input.symbol} ${input.clientOrderId} rejected class=${rejectClass} code=${venueCode ?? 'n/a'}: ${venueMessage}`);

        // Every classified reject — RETRIABLE, TERMINAL, UNKNOWN — surfaces as REJECTED state;
        // the caller branches on `rejectClass` (must-fix #1) to decide retry vs ABORTED.
        return { state: SubmitStateEnum.REJECTED, snapshot: null, rejectClass, venueCode, venueMessage };
    }

    // Boundary predicate: the submit-network-timeout path raises an ExchangeRequestException
    // carrying SUBMIT_TIMEOUT_ERROR_MARKER as its cause. We test on the structured cause
    // field (not the prose message) so a regression that changes wording cannot silently
    // reclassify timeouts as TERMINAL rejects.
    private isSubmitTimeout(cause: unknown): boolean {
        if (cause instanceof ExchangeRequestException) {
            return cause.cause === SUBMIT_TIMEOUT_ERROR_MARKER;
        }

        return false;
    }

    // Binance USDT-M Futures returns -5022 "Duplicate order id" when a clientOrderId we
    // minted is already known. Routes the executor into fetch-and-reconcile (ADR 0006 §1)
    // instead of failing the intent. Round-4 #5: code-only matching. If a future adapter
    // swallows the code, the UNKNOWN-recovery path resolves the state via
    // fetchOrderByClientId — fail-closed is correct; substring-matching the venue prose
    // is a regression risk we no longer accept.
    private isDuplicateIdReject(venueCode: string | null): boolean {
        return venueCode === '-5022';
    }

    private classifyReject(cause: unknown, venueCode: string | null): ExchangeRejectClass {
        if (venueCode !== null && BINANCE_REJECT_CLASSIFICATION[venueCode] !== undefined) {
            return BINANCE_REJECT_CLASSIFICATION[venueCode];
        }

        const errorName = this.extractCcxtErrorName(cause);

        if (errorName !== null && (CCXT_RETRIABLE_ERROR_NAMES as readonly string[]).includes(errorName)) {
            return 'RETRIABLE';
        }

        if (errorName !== null && (CCXT_TERMINAL_ERROR_NAMES as readonly string[]).includes(errorName)) {
            return 'TERMINAL';
        }

        return 'UNKNOWN';
    }

    private extractVenueCode(cause: unknown): string | null {
        const message = this.extractVenueMessage(cause);

        if (message === null) {
            return null;
        }

        // Binance error format: `{"code":-2010,"msg":"..."}` and sometimes `binance -2010 ...`.
        const codeMatch = message.match(/"code"\s*:\s*(-?\d{4,5})/) ?? message.match(/(?:^|\s)(-\d{4,5})(?=\s|:|,|$)/);

        if (codeMatch === null) {
            return null;
        }

        return codeMatch[1];
    }

    private extractVenueMessage(cause: unknown): string | null {
        if (cause instanceof ExchangeRequestException) {
            // ExchangeRequestException carries the sanitized ccxt message as `cause` (the
            // wrapper's `.cause` field), distinct from the wrapper's own .message.
            const inner = cause.cause;

            return typeof inner === 'string' ? inner : cause.message;
        }

        if (cause instanceof Error) {
            return cause.message;
        }

        return null;
    }

    private extractCcxtErrorName(cause: unknown): string | null {
        if (cause instanceof ExchangeRequestException) {
            // The wrapper hides the ccxt subclass name; fall back to scanning the sanitized
            // message for a known class prefix (ccxt embeds it as `binance {"code":...}`).
            const inner = cause.cause;

            if (typeof inner === 'string') {
                for (const name of [...CCXT_RETRIABLE_ERROR_NAMES, ...CCXT_TERMINAL_ERROR_NAMES]) {
                    if (inner.includes(name)) {
                        return name;
                    }
                }
            }

            return null;
        }

        if (cause instanceof Error) {
            return cause.constructor.name;
        }

        return null;
    }

    // Strip every key not in ALLOWED_EXTRA_PARAM_KEYS (must-fix #11). Returns a NEW object —
    // never mutates the caller's payload.
    private sanitizeExtraParams(extra: IAllowedExtraParams | undefined): Record<string, unknown> {
        const out: Record<string, unknown> = {};

        if (extra === undefined) {
            return out;
        }

        for (const key of ALLOWED_EXTRA_PARAM_KEYS) {
            const value = extra[key];

            if (value !== undefined) {
                out[key] = value;
            }
        }

        return out;
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return cause.message;
        }

        return String(cause);
    }
}
