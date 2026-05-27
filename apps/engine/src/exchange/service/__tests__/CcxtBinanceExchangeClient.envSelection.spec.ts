/**
 * R1.1 sentinel test (ADR 0032 §D8 / §D15).
 *
 * Asserts that `enableDemoTrading()` is NEVER called by
 * `CcxtBinanceExchangeClient.selectEnvironmentUrls` for any environment value
 * — TESTNET uses `setSandboxMode(true)`, PAPER and LIVE use the live URL
 * block. This is the regression guard against silent resurrection of the
 * broken DEMO design (the prior code routed every PAPER boot through
 * `enableDemoTrading()`, which swapped to a testnet-alias host that does not
 * surface `/sapi*` endpoints — see ADR 0032 §1.1).
 *
 * The test reaches into the private method via prototype to exercise the
 * branching without standing up the full ccxt client. We instantiate a
 * minimal fake client that records every call site.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CcxtBinanceExchangeClient } from '../CcxtBinanceExchangeClient';

interface IFakeCcxtClient {
    setSandboxMode: jest.Mock<void, [boolean]>;
    enableDemoTrading: jest.Mock<void, [boolean]>;
}

function buildFakeClient(): IFakeCcxtClient {
    return {
        setSandboxMode: jest.fn<void, [boolean]>(),
        enableDemoTrading: jest.fn<void, [boolean]>(),
    };
}

function invokeSelectEnvironmentUrls(fakeClient: IFakeCcxtClient, env: ExchangeEnvironmentEnum): void {
    // Bind the private method against a minimal `this` exposing only what the
    // method uses: `this.client` + `this.logger`. The cast is local; we want
    // the production method body to run unchanged.
    const stubThis = {
        client: fakeClient,
        logger: { log: jest.fn(), warn: jest.fn() },
    } as unknown as CcxtBinanceExchangeClient;

    const selectEnvironmentUrls = (
        CcxtBinanceExchangeClient.prototype as unknown as {
            selectEnvironmentUrls(env: ExchangeEnvironmentEnum): void;
        }
    ).selectEnvironmentUrls;

    selectEnvironmentUrls.call(stubThis, env);
}

describe('CcxtBinanceExchangeClient.selectEnvironmentUrls — DEMO resurrection sentinel', () => {
    it('TESTNET calls setSandboxMode(true) and does NOT call enableDemoTrading', () => {
        const fakeClient = buildFakeClient();

        invokeSelectEnvironmentUrls(fakeClient, ExchangeEnvironmentEnum.TESTNET);

        expect(fakeClient.setSandboxMode).toHaveBeenCalledWith(true);
        expect(fakeClient.enableDemoTrading).not.toHaveBeenCalled();
    });

    it('PAPER does NOT call enableDemoTrading and does NOT call setSandboxMode (live URL block)', () => {
        const fakeClient = buildFakeClient();

        invokeSelectEnvironmentUrls(fakeClient, ExchangeEnvironmentEnum.PAPER);

        expect(fakeClient.enableDemoTrading).not.toHaveBeenCalled();
        expect(fakeClient.setSandboxMode).not.toHaveBeenCalled();
    });

    it('LIVE does NOT call enableDemoTrading and does NOT call setSandboxMode (default URLs)', () => {
        const fakeClient = buildFakeClient();

        invokeSelectEnvironmentUrls(fakeClient, ExchangeEnvironmentEnum.LIVE);

        expect(fakeClient.enableDemoTrading).not.toHaveBeenCalled();
        expect(fakeClient.setSandboxMode).not.toHaveBeenCalled();
    });

    it('CcxtBinanceExchangeClient source does not reference enableDemoTrading anywhere (string sentinel)', () => {
        // Defence in depth: a source-text grep catches a future refactor that
        // re-introduces the call from a different code path the branch tests
        // would not cover (e.g. constructor, OnModuleInit, a helper).

        const source = readFileSync(resolve(__dirname, '../CcxtBinanceExchangeClient.ts'), 'utf8');
        // The string may appear in comments explaining why it is forbidden — we
        // assert only that no `.enableDemoTrading(` CALL syntax appears.
        expect(source).not.toMatch(/\.enableDemoTrading\s*\(/);
    });
});
