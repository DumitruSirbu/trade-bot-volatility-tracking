// Selects whether ExecutionService actually places orders against the exchange. M5 lands
// in DRY_RUN by default so the slice can ship through QA + reviewers without firing real
// testnet orders; operators flip to LIVE explicitly via env once the wave passes. There is
// NO 'production' value here — testnet vs live mainnet is governed by EXCHANGE_TESTNET
// (overview locked decision), not by this flag. EXECUTION_MODE only gates whether order
// submission is invoked at all on the configured exchange profile.
export enum ExecutionModeEnum {
    DRY_RUN = 'dry_run',
    LIVE = 'live',
}
