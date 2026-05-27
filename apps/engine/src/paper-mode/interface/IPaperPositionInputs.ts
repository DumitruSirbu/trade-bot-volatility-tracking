import { PositionSideEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils';
import { PaperCloseReasonEnum } from '../enum';

// Input contracts for PaperAccountStateService (ADR 0032 §D16). Money fields
// are MoneyValue (decimal.js) — never JS number. The service does not coerce
// strings; callers supply already-parsed money values so the service layer
// is responsible only for arithmetic, atomicity, and audit.

export interface IOpenPaperPositionInput {
    readonly clientOrderId: string;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly entryPrice: MoneyValue;
    readonly size: MoneyValue;
    readonly leverage: number;
    readonly openedAt: Date;
}

export interface IClosePaperPositionInput {
    readonly clientOrderId: string;
    readonly exitPrice: MoneyValue;
    readonly closedAt: Date;
    readonly closeReason: PaperCloseReasonEnum;
    readonly fees?: MoneyValue;
    readonly fundingAccrued?: MoneyValue;
    readonly slippage?: MoneyValue;
}

// Funding application input. Per ADR 0032 §D4 funding accrues at the Binance-
// published funding timestamp, not local processing time. The targeted
// position (if any) is identified by `clientOrderId` so per-position
// attribution stays explicit; a null `clientOrderId` means the funding event
// arrived for a symbol the engine no longer holds (accrued to the running
// cumulative for the read-API projection but does not touch any position).
export interface IFundingApplicationInput {
    readonly clientOrderId: string | null;
    readonly symbol: string;
    readonly fundingTs: Date;
    readonly fundingAmountUsdt: MoneyValue;
}

export interface ISnapshotInput {
    readonly takenAt: Date;
    readonly unrealisedPnlTotal: MoneyValue;
    readonly openPositionsCount: number;
}

// Output views — plain shapes the service hands back. Repositories return
// entities (persistence projections); the service maps to these views so a
// future entity-shape change does not ripple into callers (D14 read-API
// projection cleanliness).

export interface IPaperPositionView {
    readonly id: string;
    readonly clientOrderId: string;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly entryPrice: MoneyValue;
    readonly size: MoneyValue;
    readonly leverage: number;
    readonly openedAt: Date;
}

export interface IClosedPaperPositionView extends IPaperPositionView {
    readonly exitPrice: MoneyValue;
    readonly closedAt: Date;
    readonly closeReason: PaperCloseReasonEnum;
    readonly realisedPnl: MoneyValue;
    readonly fees: MoneyValue;
    readonly fundingAccrued: MoneyValue;
    readonly slippage: MoneyValue;
}

export interface IPaperBalanceView {
    readonly balanceUsdt: MoneyValue;
    readonly realisedPnlCumulative: MoneyValue;
    readonly fundingAccruedCumulative: MoneyValue;
    readonly peakEquity: MoneyValue;
}

export interface IPaperMarkPriceNotification {
    readonly symbol: string;
    readonly markPrice: MoneyValue;
    readonly observedAt: Date;
}
