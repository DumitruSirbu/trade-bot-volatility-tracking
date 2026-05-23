import { IExchangeOrderSnapshot } from '../../exchange/interface';
import { SubmitStateEnum } from '../enum';
import { IFillSummary } from './IFillSummary';

// Result of a submit/recover/cancel cycle for one clientOrderId. The orchestrator inspects
// `state` to decide whether to write a transactions row, update positions, attach SL/TP, or
// release the reservation. `fillSummary` is non-null whenever any fill landed (PARTIAL or
// FILLED); `snapshot` is the last exchange-side view (may be null on a never-acked ABORT).
export interface ISubmitOutcome {
    readonly state: SubmitStateEnum;
    readonly snapshot: IExchangeOrderSnapshot | null;
    readonly fillSummary: IFillSummary | null;
    readonly attemptN: number;
    // Sanitized exchange error message when the outcome is REJECTED/ABORTED — never a raw ccxt
    // error (those are wrapped at the ExchangeModule boundary).
    readonly errorMessage: string | null;
}
