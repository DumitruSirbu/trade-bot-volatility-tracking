import { MoneyValue } from '../../common/utils/money';

// Cheap per-symbol proximity baseline captured on each closed bar. Between bars the
// escalation check derives an approximate σ from the latest streamed price against
// this baseline (ADR §2: "approaching trigger" computed from already-streamed ticker
// data only — it must not require the deep data it gates, nor a full recompute).
export interface IEscalationBaseline {
    vwap20bar: MoneyValue;
    sigmaPctPerUnit: number; // % deviation that equals 1σ (from the closed-bar σ)
    volumeRatio: number;
}
