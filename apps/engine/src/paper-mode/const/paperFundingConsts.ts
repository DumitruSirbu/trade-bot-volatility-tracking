// Binance USDT-M Futures per-funding-window absolute cap. Standard pairs are
// bounded at 0.75% per 8h (some relaxed pairs accept ±2%). Set to 0.0075 =
// 0.75% as the conservative warn threshold; a real-world rate above this is
// rare and almost always indicates a stress regime where the audit + alert
// are the operator-relevant artefacts (ADR 0032 §D4 apply-and-alert).
//
// M11a R4 Item 5: relocated from PaperFundingAccrualService.ts so the
// magic number lives at the const boundary rather than embedded in service
// code (clean-code: configurable data at the highest level).
export const PAPER_FUNDING_RATE_CAP_ABS = 0.0075;
