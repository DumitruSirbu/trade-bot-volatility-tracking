# ADR-0024 — Alert Schema & Telegram Position Notifications

**Status:** Accepted  
**Deciders:** Architect, Security Reviewer  
**Date:** 2026-06-12

## Context

The engine generates two types of real-time alerts:
1. **System alerts** — halts, reconciliation drift, rate-limit warnings, DB backup failures.
2. **Position lifecycle alerts** — entry opens and exit closes sent to Telegram for operator visibility.

Alert payloads vary by lifecycle event type (open vs. close) and must encode sufficient metadata (symbol, leverage, prices, realized PnL) to give the operator a complete picture at a glance, while remaining terse enough to read in Telegram.

## Decision

### Alert Infrastructure (M9 + M32 Widening)

**IPositionOpenedEvent (M32 widening):**
- New interface at `apps/engine/src/common/interface/IPositionOpenedEvent.ts`
- Fields: `positionId`, `symbol`, `side`, `leverage: DecimalValue`, `entryPrice: MoneyValue`, `entryNotional: MoneyValue`, `strategyVersionId`
- `leverage` is a DecimalValue multiplier (e.g., `3` represents 3x), not money — renders as `{N}x` in alerts
- Four consumers retyped with handler bodies unchanged: `RiskListeners`, `PositionInstrumentor`, `LiveGateway`, `RiskStateLifecycleListener`
- Event emitted by `ExecutionService` on successful position open

**IPositionClosedEvent (M32 widening):**
- Added 5 new fields: `entryPrice: MoneyValue`, `exitPrice: MoneyValue | null | undefined`, `leverage: DecimalValue`, `strategyVersionId: number`, `openedAt: Date`
- Full-precision data emitted by `ExecutionService` at the close path
- `exitPrice: null` indicates the position was liquidated (no normal exit)

### Alert Message Formatting (M32)

**New pure formatter module: `positionAlertText.ts`**

Two total-formatter functions with adaptive precision:

**`formatPositionOpenedBody(event: IPositionOpenedEvent): string`**
```
Symbol BTCUSDT | 3x LONG
Entry: $42,500.12 | Qty: 0.25 BTC
Risk: $3,187.50 (7.5% acct)
```

**`formatPositionClosedBody(event: IPositionClosedEvent, fillPnl: MoneyValue, feesPaid: MoneyValue, fundingPaid: MoneyValue): string`**
```
Symbol ETHUSDT | 2x SHORT
Entry: $2,100.00 | Exit: $2,105.50 | Qty: 1.0 ETH
Realized: -$55.00 (net) | Duration: 4h 22m
```

**Adaptive price precision:**
- Price ≥ $1 → 2 decimal places (`$42,500.12`)
- Price ≥ $0.01 → 4 decimal places (`$0.0045`)
- Price < $0.01 → 8 decimal places (full precision for microcap)

**PnL labeling:**
- Realized PnL = `fillPnl − feesPaid + fundingPaid` → labeled `(net)`
- Includes acutal fees paid and funding adjustments in the single line

**Duration formatting:**
- Invokes shared `formatDuration(closedAt: Date, openedAt: Date)` utility
- Returns human-readable strings like `"4h 22m"`, `"12 days 3h"`, `"45s"`

### Data Map Structure (M32)

**`IAlertPayload.data` contract:**
- Type: `Record<string, string>` — all values serialized to strings (never nested objects)
- Null values render as `'n/a'` (never null/undefined in the wire payload)
- Used by `RiskListeners.onPositionOpened` + `onPositionClosed` for optional fields (entry/exit prices, duration)
- **Never reaches Telegram** — the alert wire protocol whitelists only `severity`, `title`, `body`; `data` is consumed by dashboard metrics only

**`RiskListeners` implementation:**
- `onPositionOpened`: builds `data` map inline (consistent with `onPositionClosed`)
- `onPositionClosed`: builds `data` map inline from event + computed PnL
- Example mapping:
  ```
  {
    positionId: event.positionId,
    symbol: event.symbol,
    leverage: `${event.leverage}x`,
    entryPrice: formatPrice(event.entryPrice),
    exitPrice: event.exitPrice ? formatPrice(event.exitPrice) : 'n/a',
    duration: formatDuration(event.closedAt, event.openedAt),
    realizedPnlUsd: realizedPnl.toString()
  }
  ```

## M32 Implementation Details

**Files created/modified:**
- `apps/engine/src/common/interface/IPositionOpenedEvent.ts` (new interface)
- `apps/engine/src/position/event/IPositionClosedEvent.ts` (widened interface)
- `apps/engine/src/alert/positionAlertText.ts` (new pure formatter module)
- `apps/engine/src/risk/listener/RiskListeners.ts` (enriched `onPositionOpened` + `onPositionClosed`)

**Four consumers retyped (handler bodies unchanged):**
1. `RiskListeners.onPositionOpened` / `onPositionClosed`
2. `PositionInstrumentor` (event timestamp + strategy version capture)
3. `LiveGateway` (broadcast to connected dashboard clients)
4. `RiskStateLifecycleListener` (lifecycle accounting recompute, unchanged logic)

**Tests:** 24 new
- 5 `positionAlertText.spec.ts` total-function tests (price precision edges, null exit price, duration rounding)
- 18 `RiskListeners.m32.spec.ts` tests (open body, close body with fees/funding, data map nullity, Telegram title/severity)
- 1 `ClosedPositionsTable.m32.spec.ts` zero-PnL edge case

## Rationale

1. **Leverage as DecimalValue** ensures consistency with risk calculations in-engine; rendered as `3x` is more natural for Telegram than `"3"` or `"leverage: 3"`.
2. **Adaptive price precision** balances readability (major coins 2dp) vs. precision (microcaps 8dp); no single format works across a 6+ order-of-magnitude price range.
3. **Realized PnL = fillPnl − feesPaid + fundingPaid** is the true P&L visible to the operator: it includes all costs and funding adjustments in one net line, labeled `(net)` to signal it's the bottom-line reality.
4. **Data map as strings** keeps the alert wire format simple and extensible; Telegram-side only consumes title/body/severity, so the data map is dashboard-only.
5. **No data map over Telegram wire** separates concerns: operational alert (Telegram) vs. operational metrics (dashboard); reduces payload size and avoids unintended exposure of internal field names.

## Risks & Mitigations

- **Risk:** Adaptive precision might confuse operators if they don't know the rules (why is Bitcoin 2dp and Doge 6dp?).
  - **Mitigation:** Operator runbook documents the rule; on-hover tooltip in dashboard shows exact precision rule.
  
- **Risk:** `exitPrice: null` for liquidations might be missed if the operator is skimming alerts.
  - **Mitigation:** The closed-body formatter always includes "Exit: $X.XX | ..." so a liquidation renders "Exit: n/a | ..." — visually distinct.

## Status

**M32 — Accepted and shipped.** All four consumers updated and tested. Formatter functions deployed live. Post-deploy: confirm Telegram alerts fire with correct symbol, leverage (Nx), entry/exit prices, realized PnL (net), and hold duration.
