import { AlertSeverityEnum, AlertTypeEnum, ExchangeEnvironmentEnum, IAlertPayload, PositionSideEnum } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ALERT_SINK, IAlertSink } from '../../alert/sink/AlertSinkModule';
import { FUNDING_RATE_OBSERVED_EVENT } from '../../common/const';
import { MoneyValue, multiplyMoneyAccounting, parseMoney } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { IFundingRateObservedEvent } from '../../market-data/interface';
import { PAPER_FUNDING_RATE_CAP_ABS } from '../const';
import { MutationKindEnum } from '../enum';
import { PaperAccountStateService } from './PaperAccountStateService';
import { PaperStateAuditHmacCodec } from './PaperStateAuditHmacCodec';

// PaperFundingAccrualService — R2c.D Item 3 (ADR 0032 §D4).
//
// Subscribes to FUNDING_RATE_OBSERVED_EVENT (emitted by
// MarketDataModule.FlowPollService when a Binance funding settlement is
// polled) and applies the rate to every PAPER position open at the
// settlement timestamp.
//
// Sign convention (ADR §D4 — account-PnL form):
//   funding_pnl = -position_notional × funding_rate × side_sign
//     side_sign(LONG)  = +1
//     side_sign(SHORT) = -1
//
// `position_notional = size × mark_price_at_funding_ts`. We read the
// position's last-known mark from PaperAccountStateService.getLastMarkPrice
// (R2c.D Item 1 keeps the cache warm via PRICE_UPDATE_EVENT); on cold start
// or for a symbol with no observed mark, we fall back to entry price and
// log the divergence. The desync vs Binance's snapshot is sub-tick under
// the restricted-profile soak.
//
// Position lifetime predicate (ADR §D4):
//   accrue iff `position.openedAt <= funding.ts <= position.closedAt`
// Because PaperAccountStateService.getOpenPositions returns ONLY currently-
// open positions, the closedAt arm of the inequality holds automatically
// (any position present in the in-memory store has not yet been closed at
// or before the event arrival). The openedAt arm is enforced here.
//
// Magnitude cap (ADR §D4): apply-and-alert (NOT zero) when the absolute
// rate exceeds PAPER_FUNDING_RATE_CAP_ABS. Silently zeroing during stress
// flatters expectancy at exactly the moment funding cost matters for
// shorts. The breach is documented by a dedicated FUNDING_CAP_BREACH audit
// row + CRITICAL Telegram alert.
//
// Force-flush MTM throttle: PaperAccountStateService.applyFunding already
// calls flushMtmForSymbolIfPending in its onCommit hook (R2b), so funding
// arrival triggers immediate MTM evaluation + drawdown check per §D4
// throttle-exemption. We do NOT need to flush explicitly here.
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2 / §3 D14): MUST NOT import ccxt or
// RateLimitPolicyService. The R2a.5 sentinel guards the closure.

// M11a R4 Item 5: PAPER_FUNDING_RATE_CAP_ABS was relocated to
// `paper-mode/const/paperFundingConsts.ts` and is imported above.

@Injectable()
export class PaperFundingAccrualService {
    private readonly logger = new Logger(PaperFundingAccrualService.name);

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly accountState: PaperAccountStateService,
        private readonly codec: PaperStateAuditHmacCodec,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
    ) {}

    @OnEvent(FUNDING_RATE_OBSERVED_EVENT)
    async onFundingObserved(event: IFundingRateObservedEvent): Promise<void> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            // Defence-in-depth — the service is registered conditionally
            // in PaperModeModule, but a misconfigured wiring under
            // LIVE/TESTNET must never mutate paper state from a live event.
            return;
        }

        const fundingTs = new Date(event.fundingTimeMs);
        const positions = this.accountState.getOpenPositions(event.symbol);

        if (positions.length === 0) {
            return;
        }

        const rateBreached = event.rate.absoluteValue().greaterThan(parseMoney(String(PAPER_FUNDING_RATE_CAP_ABS)));

        if (rateBreached) {
            await this.handleCapBreach(event, fundingTs);
        }

        for (const position of positions) {
            if (position.openedAt.getTime() > fundingTs.getTime()) {
                // Position opened AFTER the funding settlement — does not
                // accrue. Common at the boundary right after a fresh open.
                continue;
            }

            await this.accruePosition(event, position, fundingTs);
        }
    }

    // Compute funding_pnl per ADR §D4 sign convention and hand the signed
    // amount to PaperAccountStateService.applyFunding. The producer (this
    // service) owns the sign math; the state service applies the value
    // verbatim (positive credit / negative debit).
    private async accruePosition(
        event: IFundingRateObservedEvent,
        position: { clientOrderId: string; symbol: string; side: PositionSideEnum; entryPrice: MoneyValue; size: MoneyValue },
        fundingTs: Date,
    ): Promise<void> {
        const markPrice = this.resolveMarkOrFallback(position.symbol, position.entryPrice);
        // M11a R4 Item 3C: route through `multiplyMoneyAccounting`
        // (ROUND_HALF_EVEN) per the explicit warning at the top of
        // `common/utils/money.ts` — `multiplyMoney` uses ROUND_DOWN, which
        // is correct for risk-sizing (truncating never overshoots a cap)
        // but biases accounting math systematically. Funding is account-PnL
        // and MUST round banker's-even.
        const positionNotional = multiplyMoneyAccounting(position.size, markPrice);
        const sideSign = position.side === PositionSideEnum.LONG ? parseMoney('1') : parseMoney('-1');
        // funding_pnl = -position_notional × funding_rate × side_sign
        const fundingPnl = multiplyMoneyAccounting(multiplyMoneyAccounting(positionNotional, event.rate), sideSign).times(-1);

        try {
            await this.accountState.applyFunding({
                clientOrderId: position.clientOrderId,
                symbol: position.symbol,
                fundingTs,
                fundingAmountUsdt: fundingPnl,
            });

            this.logger.log(
                `PaperFundingAccrualService: applied funding to ${position.symbol} ` +
                    `clientOrderId=${position.clientOrderId} side=${position.side} ` +
                    `rate=${event.rate.toFixed()} notional=${positionNotional.toFixed()} fundingPnl=${fundingPnl.toFixed()}`,
            );
        } catch (cause) {
            this.logger.error(
                `PaperFundingAccrualService: applyFunding failed for ${position.symbol} ` +
                    `clientOrderId=${position.clientOrderId} — ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }

    private resolveMarkOrFallback(symbol: string, entryPrice: MoneyValue): MoneyValue {
        const cached = this.accountState.getLastMarkPrice(symbol);

        if (cached !== null) {
            return cached;
        }

        this.logger.warn(
            `PaperFundingAccrualService: no cached mark for ${symbol} at funding-event arrival — ` +
                `falling back to entryPrice=${entryPrice.toFixed()} for notional (sub-tick desync under restricted profile)`,
        );

        return entryPrice;
    }

    // Cap-breach: write a dedicated FUNDING_CAP_BREACH audit row (separate
    // from the per-position APPLY_FUNDING rows) and publish a CRITICAL
    // alert. We do NOT zero the rate — apply-and-alert per §D4.
    private async handleCapBreach(event: IFundingRateObservedEvent, fundingTs: Date): Promise<void> {
        const payloadHash = this.codec.hashOrderedPayload([
            ['op', 'funding_cap_breach'],
            ['symbol', event.symbol],
            ['funding_ts', fundingTs.toISOString()],
            ['rate', event.rate.toFixed()],
            ['cap_abs', String(PAPER_FUNDING_RATE_CAP_ABS)],
        ]);

        try {
            await this.accountState.appendStandaloneAuditRow({
                mutationKind: MutationKindEnum.FUNDING_CAP_BREACH,
                payloadHash,
            });
        } catch (cause) {
            this.logger.error(
                `PaperFundingAccrualService: cap-breach audit append failed for ${event.symbol} — ` +
                    `${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }

        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: fundingTs.toISOString(),
            title: 'PAPER funding cap breach',
            body: `symbol=${event.symbol} rate=${event.rate.toFixed()} cap_abs=${PAPER_FUNDING_RATE_CAP_ABS} (apply-and-alert per ADR 0032 §D4)`,
            data: {
                symbol: event.symbol,
                rate: event.rate.toFixed(),
                capAbs: String(PAPER_FUNDING_RATE_CAP_ABS),
            },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`PaperFundingAccrualService: cap-breach alert publish failed — ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
}
