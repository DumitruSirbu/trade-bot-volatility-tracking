# M18 — Directional rate-limit drift alert (silence false-positive WARNs)

**Status:** Planned
**Scope:** Engine-only (`apps/engine/`); no `packages/shared` change.
**Owner module:** ExchangeModule — `RateLimitPolicyService`.
**Related:** ADR 0030 (in-engine rate-limit token-bucket policy), ADR 0021 (kill-switch contract).

## Context

The operator receives frequent Telegram `[WARN] Rate-limit drift detected (REQUEST_WEIGHT_1M)`
messages — effectively one per 5-min coalesce window, i.e. continuous. Initial concern was that
these warnings were halting trading too often.

**Two findings reframe the work:**

1. **Drift warnings never halt trading.** In `RateLimitPolicyService.reconcileFromHeaders()` the
   429/418 halt path (`engageFreeze()`) and the drift-WARN path (`reconcileClass()` →
   `maybeFireDriftAlert()`) are mutually exclusive branches. Drift detection runs **only on
   successful responses** and only publishes a Telegram WARN — it never touches the halt flag.
   A real halt requires an actual HTTP **429/418** from Binance.

2. **The warnings are a measurement artifact, not a real risk.** Every alert shows
   `local-used ≈ 240–280 / 1920` vs `header-used ≈ 1–6 / 1920`. Binance's own counter reports
   **~0.05% of the limit** — zero ban risk. The drift fires because the detector compares
   magnitudes **symmetrically** (`Math.abs`, `RateLimitPolicyService.ts:368`), so it screams when
   the local bucket is momentarily *conservative* (`localUsed > headerUsed`) — the **safe**
   direction. The local bucket peaks transiently during bursty market-data polls then drains via
   continuous refill; reconciliation is upward-only (`:376`) so it never syncs down, leaving local
   riding high against Binance's near-empty rolling window.

**Outcome:** make the drift alert **directional** — fire only when Binance counts **more** than we
do (`headerUsed > localUsed`), the genuine "stale weight table / approaching a 429" canary
(ADR 0030 §3). Safe-direction noise stops; the real signal is preserved. Throttle/refill/halt
logic is **not touched** — trade behavior unchanged.

## Changes

### 1. Directional drift gate — `apps/engine/src/exchange/service/RateLimitPolicyService.ts`

In `reconcileClass()` (`:362–380`) replace the symmetric absolute drift with a **signed
under-count**. Leave the upward-only token reconciliation (`:376–379`) exactly as-is.

```ts
private reconcileClass(bucket: IBucket, headerUsed: number | null): void {
    if (headerUsed === null) {
        return;
    }

    const localUsed = bucket.capacity - bucket.currentTokens;
    // Only an UNDER-count is dangerous: Binance has counted more than we have,
    // so we may be approaching a 429 we cannot see. local > header is the SAFE
    // (conservative) direction and must stay silent — see ADR 0030 §2.5.
    const underCountFraction = (headerUsed - localUsed) / bucket.capacity;

    if (underCountFraction >= RATE_LIMIT_DRIFT_THRESHOLD_FRACTION) {
        this.lastDriftPct = underCountFraction;
        this.maybeFireDriftAlert(bucket, localUsed, headerUsed, underCountFraction);
    }

    if (headerUsed > localUsed) {
        // Server has counted more than we have — trust it (conservative).
        bucket.currentTokens = Math.max(0, bucket.capacity - headerUsed);
    }
}
```

- **Check `lastDriftPct` consumers.** Grep `lastDriftPct` (feeds `snapshot()` for `/v1/health`).
  With the directional change it is only set on a real under-count; confirm the snapshot reports a
  sensible value when there is no dangerous drift (e.g. `0`/`null`) and does not regress.

### 2. Alert wording — `maybeFireDriftAlert()` (`:382–404`)

- Title: `Rate-limit UNDER-COUNT detected ({className}) — approaching limit`
- Body: keep the `local-used / header-used` numbers; state the engine is under-counting vs Binance
  by `{pct}%` and may be approaching a 429.
- Keep `AlertSeverityEnum.WARN`. (`AlertTypeEnum.UNHANDLED_EXCEPTION` reuse is semantically off but
  fixing it touches `packages/shared` — out of scope; see tech-debt below.)

### 3. Constants doc — `apps/engine/src/exchange/const/rateLimitConsts.ts`

Update the comment on `RATE_LIMIT_DRIFT_THRESHOLD_FRACTION` (`:35–37`): threshold now applies to
the **signed under-count** (`headerUsed − localUsed`), not the absolute difference. No value change.

### 4. ADR — `docs/architecture/adr/0030-in-engine-rate-limit-token-bucket-policy.md` §2.5

Amend the "Drift detection" bullet to document the directional rule: the continuous-refill local
model is intentionally conservative, so `localUsed > headerUsed` is expected and benign; only
`headerUsed > localUsed` indicates a stale weight table / real ban-approach worth a Telegram WARN.

## Tests — `apps/engine/src/exchange/service/__tests__/RateLimitPolicyService.adversarial.spec.ts`

Update the existing drift specs to the directional contract and add boundary coverage:

- **Safe direction is silent:** local ≈ 250, header ≈ 1 (the screenshot case) → **no** alert.
- **Dangerous direction fires:** `headerUsed` exceeds `localUsed` by ≥ threshold → **one** alert.
- **Boundary:** under-count exactly at `RATE_LIMIT_DRIFT_THRESHOLD_FRACTION` fires; one unit below
  is silent.
- **Coalesce still holds:** repeated dangerous drift within the window → at most one alert; a
  second fires after the window elapses.
- Confirm upward-only token reconciliation and any `snapshot()` drift field are unchanged.

## Dispatch waves

1. **bot-engine-nestjs** — changes 1–3 (service + const).
2. **bot-qa-engineer** — directional + boundary + coalesce tests above.
3. **bot-review-logic + bot-review-clean-code** — verify halt path untouched, canary semantics
   preserved, `lastDriftPct`/snapshot consumers don't regress. (security/quant light — no
   key/PnL surface.)
4. **bot-scribe** — ADR 0030 §2.5 amendment, `docs/work-log.md`, `docs/milestone-log.md` entry,
   and tech-debt entries (below).

## Verification

- `rtk jest` scoped to `RateLimitPolicyService.adversarial.spec.ts` — green; the new
  safe-direction-silent test fails against the old `Math.abs` code and passes after the change.
- Full `apps/engine` suite green — no regression in 429/418 freeze, escalation, reconciliation.
- Manual trace: `reconcileFromHeaders` with `usedWeight1m = 1` while bucket shows
  `localUsed ≈ 250` → assert `alerts.publish` **not** called; with `usedWeight1m = capacity − 50`
  and `localUsed ≈ 10` → assert exactly one WARN.
- Confirm no `packages/shared` diff and no change to `engageFreeze`/halt code in the final diff.

## Out of scope (tech-debt)

- **`AlertTypeEnum.UNHANDLED_EXCEPTION` misuse** for drift — replace with a dedicated
  `RATE_LIMIT_DRIFT` type (shared enum change). LOW.
- **`header-used ≈ 1` anomaly** — investigate possible public-market-data vs account-endpoint
  weight-ledger split (local bucket may charge weights Binance tallies on a separate IP ledger).
  Diagnostic. MEDIUM.
- **Real-429 hardening** (batch/space the 100-symbol OI & funding bursts) — worst-case load is
  ~10%, so deferred. LOW.
