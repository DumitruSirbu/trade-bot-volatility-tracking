import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { BootModeHistoryModule } from '../boot-mode-history/BootModeHistoryModule';
import { AppConfigModule } from '../config/AppConfigModule';
import { ControlModule } from '../control/ControlModule';
import {
    PaperAccountSnapshotEntity,
    PaperAccountStateEntity,
    PaperAccountStateHistoryEntity,
    PaperAccountStateMetaEntity,
    PaperSimulatorIdempotencyEntity,
    PaperStateAuditEntity,
} from './entity';
import { PaperAccountSnapshotRepository } from './repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from './repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from './repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from './repository/PaperAccountStateRepository';
import { PaperSimulatorIdempotencyRepository } from './repository/PaperSimulatorIdempotencyRepository';
import { PaperStateAuditRepository } from './repository/PaperStateAuditRepository';
import {
    PaperAccountStateService,
    PaperAccountStateSource,
    PaperDrawdownAbortHandler,
    PaperExecutionClient,
    PaperFillSimulator,
    PaperFundingAccrualService,
    PaperMarkPriceSubscriptionBridge,
    PaperReconciliationAdapter,
    PaperStateAuditHmacCodec,
    StreamingFillAdapter,
} from './service';

// PAPER-mode provider container (ADR 0032 §2).
//
// R2b wave-B form. Adds `PaperAccountStateService` (the in-memory + persisted
// projection state owner), `PaperStateAuditRepository`, and
// `PaperStateAuditHmacCodec`. `PaperAccountStateSource` now delegates to
// `PaperAccountStateService` instead of returning empty arrays.
//
// R2c–R2d will grow the module with `PaperFillSimulator`,
// `PaperReconciliationAdapter`, `PaperExchangeNullityProbe`,
// `PaperFundingAccrualService`, and `PaperBootStateSource`.
//
// R2c.D wave (this commit) adds four PAPER-only providers:
//   - PaperMarkPriceSubscriptionBridge — forwards PRICE_UPDATE_EVENT to
//     PaperAccountStateService.notifyMarkPrice + StreamingFillAdapter.notifyTick.
//   - PaperDrawdownAbortHandler — subscribes to PAPER_MARK_TO_MARKET_EVENT,
//     trips the M0 halt flag + writes a DRAWDOWN_ABORT audit row + fires a
//     CRITICAL Telegram alert when equity <= peak * 0.85.
//   - PaperFundingAccrualService — subscribes to FUNDING_RATE_OBSERVED_EVENT,
//     applies the signed funding amount to every open paper position open at
//     the settlement timestamp; cap breaches go through a FUNDING_CAP_BREACH
//     audit row + CRITICAL alert (apply-and-alert per §D4).
//   - Chain-integrity walker is invoked from inside
//     PaperAccountStateService.hydrateOnBoot — no separate provider.
//
// All three new event subscribers internally short-circuit when
// `appConfig.exchangeEnv !== PAPER`. Registered unconditionally because Nest
// must instantiate the provider for the @OnEvent decorators to wire — the
// env-conditional no-op guard makes them safe under LIVE/TESTNET. The
// imports below add AppConfigModule + ControlModule + AlertSinkModule to
// resolve the cross-module dependencies the three new services need.
//
// CRITICAL boundary (ADR 0032 §2 — compile-time invariants):
//   - This module MUST NOT import `ExchangeModule`, `RateLimitPolicyService`,
//     or any ccxt module. The two exceptions live OUTSIDE this module:
//     `KeyPermissionAssertionService` (boot-time `/sapi` calls) and the
//     future `PaperExchangeNullityProbe` (which itself lives in `paper-mode/`
//     but is explicitly whitelisted to call the live ccxt account-state
//     methods through the D14 capability guard).
//   - `BootModeHistoryModule` is imported to surface `BootstrapSubkeyDeriver`
//     (HKDF per-purpose sub-key derivation; same primitive both chains use).
//     The boot-mode chain itself is not invoked from PAPER providers — only
//     the deriver primitive crosses the boundary.
//   - The R2a.5 module-graph sentinel test walks the provider closure and
//     fails the build if a ccxt or rate-limit dependency creeps in.

@Module({
    imports: [
        TypeOrmModule.forFeature([
            PaperAccountStateEntity,
            PaperAccountStateHistoryEntity,
            PaperAccountStateMetaEntity,
            PaperAccountSnapshotEntity,
            PaperSimulatorIdempotencyEntity,
            PaperStateAuditEntity,
        ]),
        AppConfigModule,
        AlertSinkModule,
        BootModeHistoryModule,
        ControlModule,
    ],
    providers: [
        PaperExecutionClient,
        PaperAccountStateSource,
        PaperAccountStateService,
        PaperFillSimulator,
        StreamingFillAdapter,
        PaperMarkPriceSubscriptionBridge,
        PaperDrawdownAbortHandler,
        PaperFundingAccrualService,
        // M11a R2d Item 1 (ADR 0032 §D12). Periodic in-memory-vs-persisted
        // diff. Provider is registered unconditionally; constructor short-
        // circuits in non-PAPER (mirrors R2c.D handlers). Drift = CRITICAL
        // halt + Telegram alert + drift-detected event.
        PaperReconciliationAdapter,
        PaperAccountStateRepository,
        PaperAccountStateHistoryRepository,
        PaperAccountStateMetaRepository,
        PaperAccountSnapshotRepository,
        PaperSimulatorIdempotencyRepository,
        PaperStateAuditRepository,
        PaperStateAuditHmacCodec,
    ],
    exports: [
        PaperExecutionClient,
        PaperAccountStateSource,
        PaperAccountStateService,
        PaperFillSimulator,
        StreamingFillAdapter,
        PaperMarkPriceSubscriptionBridge,
        PaperDrawdownAbortHandler,
        PaperFundingAccrualService,
        PaperReconciliationAdapter,
        PaperAccountStateRepository,
        PaperAccountStateHistoryRepository,
        PaperAccountStateMetaRepository,
        PaperAccountSnapshotRepository,
        PaperSimulatorIdempotencyRepository,
        PaperStateAuditRepository,
        PaperStateAuditHmacCodec,
    ],
})
export class PaperModeModule {}
