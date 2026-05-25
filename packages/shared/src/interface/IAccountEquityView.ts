export interface IAccountEquityView {
    equityUsd: string;
    marginUsed: string | null;
    freeMargin: string | null;
    openExposureUsd: string | null;
    asOf: string;
}
