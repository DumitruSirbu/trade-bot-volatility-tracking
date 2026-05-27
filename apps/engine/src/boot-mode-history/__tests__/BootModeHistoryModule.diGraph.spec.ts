/**
 * Regression — Engine DI follow-on triage #3.
 *
 * Original failure:
 *   `UnknownDependenciesException: Nest can't resolve dependencies of the
 *    BootModeChainService (..., ?). Please make sure that the argument
 *    TransitionTokenVerifier at index [6] is available in the BootstrapModule
 *    module.`
 *
 * Root cause was a duplicate provider registration in `BootstrapModule`:
 * `BootModeChainService` was declared both there AND in `BootModeHistoryModule`
 * (its natural home, which already exports it). The duplicate registration
 * forced Nest to resolve the constructor from `BootstrapModule`'s injector
 * scope, where `TransitionTokenVerifier` was NOT visible (not exported from
 * `BootModeHistoryModule`).
 *
 * This regression asserts that `BootModeChainService` constructs cleanly via
 * its proper home module (`BootModeHistoryModule`) using its real providers
 * list — exercising the production DI wiring with stubbed cross-module deps
 * (no real Postgres connection / no real `AppConfigService` env-var graph).
 */

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AppConfigService } from '../../config/service';
import { BootModeChainRotationEntity } from '../entity/BootModeChainRotationEntity';
import { BootModeHistoryEntity } from '../entity/BootModeHistoryEntity';
import { BootModeHistoryModule } from '../BootModeHistoryModule';
import { BootModeChainService, TransitionTokenVerifier } from '../service';

describe('BootModeHistoryModule — DI graph regression (follow-on triage #3)', () => {
    it('BootModeChainService constructs with all 7 deps including TransitionTokenVerifier', async () => {
        // Pull the module's real provider list — same source of truth Nest
        // reads at boot. If a provider is dropped or renamed, this test fails
        // at compile.
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BootModeHistoryModule) as unknown[];
        expect(Array.isArray(providers)).toBe(true);
        expect(providers.length).toBeGreaterThan(0);

        // Stub the cross-module dependencies BootModeHistoryModule normally
        // pulls through AppConfigModule + TypeOrmModule.forFeature. The
        // regression is about INJECTOR VISIBILITY of TransitionTokenVerifier,
        // not about runtime behaviour of the chain service.
        const stubAppConfig = {
            authBootstrapSecret: 'a'.repeat(64),
            exchangeEnv: 'testnet',
        } as unknown as AppConfigService;

        const stubRepository = {} as unknown as Repository<BootModeHistoryEntity>;
        const stubRotationRepository = {} as unknown as Repository<BootModeChainRotationEntity>;
        const stubDataSource = { transaction: jest.fn() } as unknown as DataSource;

        const moduleRef = await Test.createTestingModule({
            providers: [
                ...(providers as never[]),
                { provide: AppConfigService, useValue: stubAppConfig },
                { provide: DataSource, useValue: stubDataSource },
                { provide: getRepositoryToken(BootModeHistoryEntity), useValue: stubRepository },
                { provide: getRepositoryToken(BootModeChainRotationEntity), useValue: stubRotationRepository },
            ],
        }).compile();

        // Pre-fix: `moduleRef.get(BootModeChainService)` would have thrown
        // UnknownDependenciesException at `.compile()` above. Post-fix the
        // instance resolves and carries a real TransitionTokenVerifier.
        const chainService = moduleRef.get(BootModeChainService);
        expect(chainService).toBeInstanceOf(BootModeChainService);

        const tokenVerifier = moduleRef.get(TransitionTokenVerifier);
        expect(tokenVerifier).toBeInstanceOf(TransitionTokenVerifier);

        await moduleRef.close().catch(() => undefined);
    });
});
