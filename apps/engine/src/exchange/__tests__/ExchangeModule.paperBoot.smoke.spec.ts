/**
 * M11a R2a-fix-wave-2 Item 5 — PAPER boot smoke (engine-side fallback form).
 *
 * Per the R2a-fix-wave-2 instructions: "the smoke can fall back to: bootstrap
 * the NestJS root module via Test.createTestingModule(...).compile() with
 * EXCHANGE_ENV=paper set, and assert it compiles without throwing".
 *
 * We bootstrap a TestingModule with `ExchangeModule.providers` directly
 * (rather than importing the full `AppModule`) because:
 *   1. `AppModule` requires Postgres + auth keys + a working
 *      `DerivedKeyService` chain that has a pre-existing DI defect on the
 *      local dev `.env` (manifests under TESTNET *and* PAPER equally — see
 *      the report from this fix wave; not introduced here).
 *   2. Importing `ExchangeModule` directly drags in `AlertSinkModule`
 *      which forwardRef's into `AuthModule`, surfacing a circular-import
 *      tangle unrelated to this fix wave.
 *   3. The R2a-fix-wave-2 Item 1 regression blocked the DI graph from
 *      *constructing* `CcxtExecutionClient` under PAPER (the ctor threw
 *      `PaperExecutionGuardException` via the now-removed assertion).
 *      That is exactly what this smoke verifies — the providers list is
 *      the production source of truth for that constructor.
 *
 * Assertions:
 *   - The compiled DI graph instantiates `CcxtExecutionClient` (Nest must
 *     do this under PAPER for the env-factory `inject:` list).
 *   - `EXECUTION_CLIENT` resolves to `PaperExecutionClient` under PAPER.
 *   - `ACCOUNT_STATE_SOURCE` resolves to `PaperAccountStateSource` under PAPER.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { AppConfigService } from '../../config/service';
import { PaperAccountStateService, PaperAccountStateSource, PaperExecutionClient, PaperFillSimulator, StreamingFillAdapter } from '../../paper-mode/service';
import { PaperSimulatorIdempotencyRepository } from '../../paper-mode/repository/PaperSimulatorIdempotencyRepository';
import { ExchangeModule } from '../ExchangeModule';
import { ACCOUNT_STATE_SOURCE, ENGINE_EXECUTION_CLIENT, EXECUTION_CLIENT } from '../interface';
import { RATE_LIMIT_HALT_PORT } from '../interface/IRateLimitHaltPort';
import { CcxtBinanceExchangeClient, CcxtExecutionClient, ExchangeAccountStateSource } from '../service';
import { ALERT_SINK } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { HaltService } from '../../control/HaltService';
describe('ExchangeModule — PAPER boot smoke (R2a-fix-wave-2 Item 5)', () => {
    const paperAppConfig = {
        exchangeEnv: ExchangeEnvironmentEnum.PAPER,
        exchangeApiKey: 'paper-test-key',
        exchangeApiSecret: 'paper-test-secret',
        activeStrategyVersionId: 1,
    } as unknown as AppConfigService;

    it('PAPER DI graph compiles — CcxtExecutionClient constructor no longer throws (R2a-fix-wave-2 Item 1)', async () => {
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ExchangeModule) as unknown[];
        expect(Array.isArray(providers)).toBe(true);

        // Stub the cross-module deps `ExchangeModule.providers` would normally
        // pull through its `imports:` list. The smoke's scope is the PAPER
        // wiring inside ExchangeModule, not the full bootstrap chain.
        const moduleRef = await Test.createTestingModule({
            providers: [
                ...(providers as never[]),
                PaperExecutionClient,
                PaperAccountStateSource,
                // R2c.C wave — PaperExecutionClient now depends on
                // PaperFillSimulator + the idempotency repository. Stub both;
                // the smoke verifies port binding under PAPER, not simulator
                // semantics (covered by PaperFillSimulator.idempotency.spec
                // and StreamingFillAdapter.causality.spec).
                {
                    provide: PaperFillSimulator,
                    useValue: { simulateFill: jest.fn() },
                },
                {
                    provide: StreamingFillAdapter,
                    useValue: {
                        notifyTick: jest.fn(),
                        simulateOrderFill: jest.fn(),
                        registerPosition: jest.fn(),
                        releasePosition: jest.fn(),
                        // M11a R4 Item 3A — getLastSnapshot is needed by
                        // PaperFillSimulator.simulateFill to derive the
                        // reference price before delegating to the shared
                        // core. The smoke verifies port wiring only;
                        // a stub that returns null exercises the no-tick
                        // missed-fill branch deterministically.
                        getLastSnapshot: jest.fn(() => null),
                    },
                },
                {
                    provide: PaperSimulatorIdempotencyRepository,
                    useValue: { findByKey: jest.fn(), insertNew: jest.fn() },
                },
                // R2b wave B: PaperAccountStateSource now depends on
                // PaperAccountStateService. Stub it for this smoke — the
                // smoke verifies port wiring under PAPER, not the
                // simulator's in-memory state semantics (those are
                // covered by PaperAccountStateService.atomicity.spec).
                {
                    provide: PaperAccountStateService,
                    useValue: {
                        getOpenPositions: () => [],
                        getBalance: () => ({ balanceUsdt: { toFixed: () => '0' } }),
                    },
                },
                { provide: AppConfigService, useValue: paperAppConfig },
                { provide: ALERT_SINK, useValue: { publish: jest.fn(), publishMany: jest.fn() } },
                { provide: RATE_LIMIT_HALT_PORT, useValue: { requestHalt: jest.fn(), isHalted: () => false } },
                // M11a R2d Item 2 — PaperExchangeNullityProbe (now a
                // provider in ExchangeModule) depends on HaltFlagService +
                // HaltService for its CRITICAL-halt path. Stub both at the
                // smoke level; the probe's actual halt semantics are
                // covered by PaperExchangeNullityProbe.adversarial.spec.
                { provide: HaltFlagService, useValue: { halt: jest.fn(), isHalted: () => false } },
                { provide: HaltService, useValue: { notePragmaticTransition: jest.fn() } },
            ],
        }).compile();

        expect(moduleRef).toBeDefined();

        // The Ccxt-backed concrete is constructible under PAPER — Nest
        // builds it for the EXECUTION_CLIENT env-factory `inject:` list.
        // Before the R2a-fix-wave-2 Item 1 fix this would have thrown
        // PaperExecutionGuardException at construction time.
        const ccxtExec = moduleRef.get(CcxtExecutionClient);
        expect(ccxtExec).toBeInstanceOf(CcxtExecutionClient);

        // The Ccxt-backed account-state source is similarly constructible.
        const ccxtAcct = moduleRef.get(ExchangeAccountStateSource);
        expect(ccxtAcct).toBeInstanceOf(ExchangeAccountStateSource);

        // The Ccxt-backed exchange client is constructible (its ctor does NOT
        // open a network connection — only configures ccxt).
        const ccxtClient = moduleRef.get(CcxtBinanceExchangeClient);
        expect(ccxtClient).toBeInstanceOf(CcxtBinanceExchangeClient);

        // Port dispatch must select the PAPER adapters.
        const executionPort = moduleRef.get(EXECUTION_CLIENT);
        const accountStatePort = moduleRef.get(ACCOUNT_STATE_SOURCE);
        expect(executionPort).toBeInstanceOf(PaperExecutionClient);
        expect(accountStatePort).toBeInstanceOf(PaperAccountStateSource);

        // M11a R4 Item 4C — engine-shape execution port must ALSO select the
        // PAPER adapter, so ExchangeOrderSubmitter / ProtectiveOrderAttacher
        // route through PaperExecutionClient under PAPER instead of the
        // PaperExecutionGuardException-throwing concrete.
        const engineExecutionPort = moduleRef.get(ENGINE_EXECUTION_CLIENT);
        expect(engineExecutionPort).toBeInstanceOf(PaperExecutionClient);

        // Best-effort close — `CcxtBinanceExchangeClient.onModuleDestroy`
        // calls into the live ccxt client which may throw under the stubbed
        // env. Swallow: the smoke's invariant (graph compiles + correct
        // ports bound) has already been verified.
        await moduleRef.close().catch(() => undefined);
    });
});
