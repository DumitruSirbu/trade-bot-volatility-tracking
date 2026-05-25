import { Module } from '@nestjs/common';

import { ControlModule } from '../control/ControlModule';
import { PositionModule } from '../position/PositionModule';
import { DailyPnlSummaryScheduler } from './DailyPnlSummaryScheduler';
import { RiskListeners } from './listeners/RiskListeners';
import { AlertSinkModule } from './sink/AlertSinkModule';

// M9 W1 (ADR 0024 §IAlertSink port + ADR 0025 §2.4 order-of-operations).
//
// `AlertModule` is the FIRST I/O module wired into the engine — it must sit
// structurally ABOVE every persistence-touching module so that the schema
// validation gate (PHASE 0) and any other early-boot failure has a sink to
// publish to.
//
// Post M8 (M9 boot-fix): the sink port + Noop + Telegram + rate-limiter +
// production-vs-noop factory moved into `AlertSinkModule` (a true leaf, no
// project imports beyond `AppConfigService`). That break-out resolves the
// HaltService DI failure caused by `forwardRef`'d Symbol DI tokens not
// resolving correctly under NestJS 11. See `sink/AlertSinkModule.ts`.
//
// AlertModule now owns ONLY the cross-domain consumers:
//   - `RiskListeners`             — bridges domain bus events (M4 halt /
//                                   divergence, M5 terminal reject, M6
//                                   open/close) to the sink + the in-memory
//                                   halt flag + HaltService transition note.
//   - `DailyPnlSummaryScheduler`  — fires the UTC-midnight PnL line.
//
// Both consumers need `HaltService` (control) — the dependency is one-way
// (AlertModule → ControlModule), no cycle, no forwardRef.

// Backwards-compat re-exports: existing imports of `ALERT_SINK`, `IAlertSink`,
// and `NoopAlertSink` from `alert/AlertModule` (bootstrap + tests) keep
// resolving against the same symbols now owned by `AlertSinkModule`. New code
// should import directly from `alert/sink/AlertSinkModule`.
export { ALERT_SINK, IAlertSink, NoopAlertSink } from './sink/AlertSinkModule';

@Module({
    imports: [AlertSinkModule, ControlModule, PositionModule],
    providers: [DailyPnlSummaryScheduler, RiskListeners],
    exports: [AlertSinkModule],
})
export class AlertModule {}
