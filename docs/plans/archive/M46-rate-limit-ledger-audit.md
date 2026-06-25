# M46 — Rate-limit ledger audit (`header-used ≈ 1` anomaly investigation)

**Status:** Planned (queued behind the active milestone; see `docs/plans/README.md`).
**Scope:** Engine-only (`apps/engine/`) for any code change; investigation-first. No `packages/shared` change anticipated.
**Owner module:** ExchangeModule — `RateLimitPolicyService`, `parseRateLimitHeaders`, `CcxtBinanceExchangeClient`.
**Related:** ADR 0030 (in-engine rate-limit token-bucket policy), M17 (origin), M18 (directional drift alert — `docs/plans/archive/M18-rate-limit-drift-directional-alert.md`).
**Resolves:** tech-debt **H4** (HIGH) — *Rate-limit drift `header-used ≈ 1` anomaly — public endpoint on different IP-weight ledger?*

---

## Context

### The anomaly

The engine's local token bucket for `REQUEST_WEIGHT_1M` reports `localUsed ≈ 240–280 / 1920`
(the charges accrued by the 100-symbol OI + funding + ticker polling loop), while Binance's
own `X-MBX-USED-WEIGHT-1M` response header consistently returns `≈ 1–6 / 1920`. The two
numbers disagree by **two orders of magnitude** and have done so since M17.

`reconcileFromHeaders()` → `reconcileClass()` maps every header to **one** bucket:

| Header | Bucket |
|---|---|
| `X-MBX-USED-WEIGHT-1M` | `REQUEST_WEIGHT_1M` |
| `X-MBX-ORDER-COUNT-10S` | `ORDERS_10S` |
| `X-MBX-ORDER-COUNT-1M` | `ORDERS_1M` |
| *(none)* | `RAW_REQUESTS_5M` |

`RAW_REQUESTS_5M` is already a header-less local-only bucket — `reconcileClass` is never called
for it because no `X-MBX-*` header maps to it (`parseRateLimitHeaders.ts`). This precedent is
directly relevant to Scenario A: the codebase already runs one reconciliation-free bucket safely,
which informs whether a header-less `MARKET_DATA_WEIGHT_*` bucket would be an acceptable fallback
if I1 finds the market-data ledger has no distinct readable header.

The local bucket is charged `OPERATION_REQUEST_WEIGHTS[op]` for **every** call routed through
`callExchange()` — including the high-frequency public market-data reads
(`fetchOpenInterest=1`, `fetchFundingRate=1`, `fetchTickers=40`). The hypothesis (M18
out-of-scope note) is that Binance tallies those public market-data endpoints on a **separate
IP-level weight ledger** from the authenticated account endpoints, and the single
`X-MBX-USED-WEIGHT-1M` header the engine reads reflects only **one** of those ledgers — so the
engine charges one local bucket for two distinct venue ledgers, or charges a local bucket that
the header never describes.

### Why it matters (why HIGH, not MEDIUM as originally deferred)

The disagreement is not cosmetic. If the engine's mental model of the ledger structure is
wrong, exactly one of two unsafe states is true and we currently cannot tell which:

1. **Under-counting the real ledger.** If the public market-data polls accrue weight on a
   ledger the engine is *not* watching, the engine could approach a real 429 on that ledger
   silently — the directional drift alert (M18) only fires on `headerUsed > localUsed` for the
   *one* header it reads, so a second, unread ledger nearing its cap is invisible. This is a
   go-live-blocker class of failure: a 418 IP ban during a single-host soak halts
   reconciliation, kill-switch confirmation, and protective-order arming (ADR 0030 §1).
2. **Over-counting a phantom ledger.** If the public polls *don't* count against the
   `REQUEST_WEIGHT_1M` ledger the header describes (or count far less than the engine charges),
   the local bucket throttles market-data polls unnecessarily — degrading gate-evaluation
   freshness for no venue-side benefit.

Both failure modes are real; the audit's job is to determine **which one (if either)** the
engine is in, with evidence, and then take the minimal correct action.

### Why deferred until now

M18 shipped the **directional drift alert** (fire only when `headerUsed > localUsed`), which
made the anomaly *silent in normal operation* — the safe-direction `localUsed ≫ headerUsed`
noise stopped. M18 explicitly scoped the **root-cause ledger investigation** out as diagnostic /
deferred because the alert change removed the operational pain without needing to understand the
ledger split. `tech-debt.md` carries it as **H4 / HIGH** because the silenced symptom hides a
genuine go-live correctness gap. M46 is that deferred root-cause audit.

---

## Investigation tasks (do these first — they decide the deliverable)

The audit is evidence-led. **No code change is committed until I1–I4 produce a documented
finding** that selects one of the deliverable scenarios in the next section.

### I1 — Map Binance's published ledger structure for the endpoints we call

Using `context7-mcp` for the current ccxt Binance USDT-M Futures surface, and the Binance
Futures API docs (the source-of-truth URL pinned in `rateLimitConsts.ts`), build a table of
**every operation in `OPERATION_REQUEST_WEIGHTS`** with:

- the endpoint path ccxt maps it to (e.g. `fetchOpenInterest` → `GET /fapi/v1/openInterest`),
- the documented `REQUEST_WEIGHT`,
- the **rate-limit scope** (per-IP vs per-UID) Binance documents for that endpoint,
- which `X-MBX-USED-WEIGHT-*` / `X-MBX-ORDER-COUNT-*` header(s) the endpoint's response
  carries, and whether `fapi` market-data endpoints and `fapi` account endpoints return the
  **same** `X-MBX-USED-WEIGHT-1M` value or distinct values.

Key questions to answer explicitly, with doc citations:

1. **Do USDT-M Futures public market-data endpoints and authenticated account endpoints share a
   single per-IP `REQUEST_WEIGHT` ledger, or are they tallied separately?**
2. **If they are separate: does the market-data ledger expose a distinct, readable
   `X-MBX-USED-WEIGHT-*` response header?** This is a hard gate for Scenario A — a split bucket
   with no readable header has no reconciliation feedback (it becomes a second `RAW_REQUESTS_5M`,
   which the codebase already runs safely via local-only accounting; document explicitly whether
   that is acceptable or whether it recreates the invisible-ledger risk). If no readable header
   exists, Scenario A must specify: keep the new bucket but document the residual monitoring
   gap, or reject the split and fall back to Scenario B/C.

### I2 — Capture live header evidence (read-only, no order path)

From a running paper/soak engine (or a short read-only diagnostic harness that only calls the
market-data + account read endpoints — **never** the order path), capture the **raw**
`last_response_headers` for one full poll cycle, grouped by endpoint category:

- A pure market-data call (`fetchOpenInterest`, `fetchFundingRate`, `fetchTickers`).
- A pure account call (`fetchBalance`, `fetchPositions`, `fetchOpenOrders`).

Record, per category, the exact `X-MBX-USED-WEIGHT-1M` value returned **immediately after**
that call, alongside the engine's `localUsed` at that instant (from `snapshot()`). This shows
empirically whether the header value jumps after account calls but stays near-zero after
market-data calls (→ separate-ledger confirmed) or tracks the running local total (→
over-counting / weight-table drift).

> **Capture safety — ACCEPTANCE CRITERIA for the I2 harness:**
> 1. **Read-only.** Must not place, modify, or cancel orders; must not touch the risk gate; run
>    paper/testnet first.
> 2. **Redacted numeric-only projection.** The harness MUST extract header values via
>    `parseRateLimitHeaders` (or an explicit allow-list of `x-mbx-used-weight-*` /
>    `x-mbx-order-count-*` keys) — never serialize the raw `last_response_headers` bag. Binance
>    authenticated-endpoint responses can carry `X-MBX-APIKEY` echoes and other sensitive fields;
>    the production `parseRateLimitHeaders.ts` already projects only four numeric fields and must
>    be reused here. Any diagnostic log line must pass through pino's existing redact config
>    (`apiKey`, `secret`, `token`, `authorization`, `password`).
> 3. **Route through `callExchange()`/the limiter.** Do NOT call ccxt directly; the harness must
>    go through the production `CcxtBinanceExchangeClient` so every call is counted by the limiter
>    and subject to `acquire()` back-pressure. Bypassing `callExchange()` would let the harness
>    itself trip the 429/418 it is investigating.
> 4. **Side-effect awareness.** `callExchange()` calls `reconcileFromHeaders()` which mutates
>    `currentTokens` (upward-only reconcile when `headerUsed > localUsed`). The captured
>    `localUsed` from `snapshot()` therefore reflects a post-reconcile value. This is acceptable
>    for the comparison (the direction of the anomaly is unambiguous at two orders of magnitude)
>    but must be noted in the finding write-up so it is not misread as a pre-call baseline.

### I3 — Audit what the engine charges per call category

Trace, in `RateLimitPolicyService.debitAll()` + `OPERATION_REQUEST_WEIGHTS`, the **total
weight the engine charges per minute** in the steady-state poll loop:

- Count the per-cycle calls (100 symbols × {OI=1, funding=1} + 1× `fetchTickers`=40 +
  reconciliation/account reads) and multiply by their table weights.
- Confirm whether the measured `localUsed ≈ 240–280` is within **±30 tokens** of the gross
  per-cycle charge arithmetic. The continuous-refill model drains the bucket between debits, so
  instantaneous `localUsed` is always somewhat below the gross charge — a gap up to ~30 tokens is
  expected. A gap larger than that suggests either a missing debit or a weight-table error (local
  accounting bug). This validates that the disagreement is isolated to the *header*, not a local
  bug.
- Verify the per-operation weights in the table against the I1 published weights — flag any
  stale entry (the M18 directional canary exists precisely for stale weights).

### I4 — Classify the finding

Combine I1–I3 into one of three verdicts, with the supporting evidence inline:

- **(A) Separate-ledger confirmed** — market-data endpoints are on a per-IP ledger the read
  header does not (fully) describe; the engine conflates two ledgers in one bucket.
- **(B) Over-counting / no separate ledger** — endpoints share one ledger; the engine's local
  charges are simply higher than Binance's tally (e.g. ccxt batching `fetchTickers` into one
  weighted request, or a stale/inflated weight in the table).
- **(C) No issue** — the disagreement is fully explained by the intentional conservative
  continuous-refill model (ADR 0030 §2.5) and there is no correctness gap. **C can only be the
  verdict if the `X-MBX-USED-WEIGHT-1M` header is observed climbing meaningfully (into the tens
  or higher) during a burst.** A header that is *persistently* near-zero (`≈ 1–6` even during a
  full 240-weight OI+funding+ticker cycle) is structural, not a transient refill artifact — the
  conservative-model explanation would still show the header reaching a transient peak before
  draining. If the header stays near-zero throughout the burst, the I4 verdict must be A or B,
  not C.

---

## Deliverables (scenario-gated by I4)

The committed change depends on the verdict. **Exactly one** of the following ships.

### Scenario A — Separate ledger confirmed → split the bucket

**Pre-condition (from I1):** I1 must have confirmed (a) a separate market-data ledger exists
and (b) it exposes a **distinct readable `X-MBX-USED-WEIGHT-*` header**. If the market-data
ledger has no readable header, Scenario A still splits the bucket but must document the residual
monitoring gap explicitly in ADR 0030 and the tech-debt entry — a header-less bucket is local-only
accounting, analogous to the existing `RAW_REQUESTS_5M` bucket. The architect decides whether that
gap is acceptable before the implementation wave.

- Introduce a distinct `MARKET_DATA_WEIGHT_*` bucket (per-IP, 1-minute) in
  `RateLimitPolicyService`, fed by the market-data operations, with its own published-limit
  constant in `rateLimitConsts.ts` and its own header mapping in `parseRateLimitHeaders` /
  `reconcileClass` (or local-only if no header exists per above). The authenticated
  `REQUEST_WEIGHT_1M` bucket then only carries account calls, so its header
  (`X-MBX-USED-WEIGHT-1M`) and `localUsed` reconcile correctly.
- Wire each operation in `OPERATION_REQUEST_WEIGHTS` to its owning bucket (market-data vs
  account) — explicit, not inferred at the call site (preserves the ADR 0030 §2.2 contract).
- **The new bucket MUST be added to the `allBuckets` getter.** `engageFreeze()` zeroes
  `allBuckets` and the freeze path suspends refill across `allBuckets`. A market-data bucket
  outside `allBuckets` would keep refilling and keep issuing the public polls that earned a 418
  IP ban — defeating the freeze protection entirely. The QA wave MUST include an assertion: "a
  418 freeze drains and suspends the market-data bucket alongside the existing four buckets."
- Extend `snapshot()` to expose the new bucket for `/v1/health` and the dashboard.
- Amend **ADR 0030 §2.1 / §2.5** to document the dual per-IP ledger and the per-bucket header
  mapping. Surface to the main session if this conflicts with the §2.1 four-bucket model
  (it amends, not contradicts — but flag it).

### Scenario B — Over-counting confirmed → recalibrate weight charges

- Correct the offending entries in `OPERATION_REQUEST_WEIGHTS` to the **Binance-documented**
  per-endpoint weight from I1 (cite the exact doc section in the const comment). The corrected
  weight must match the Binance API reference, **not** merely ccxt's inferred value. If ccxt's
  inferred weight differs from the Binance-documented weight, use the Binance-documented value
  (the conservative choice) and note the divergence.
- **No weight entry may be set below its I1-documented value.** The QA wave MUST include an
  assertion confirming no `OPERATION_REQUEST_WEIGHTS` entry was lowered below the Binance
  reference weight for that endpoint.
- No new bucket. `localUsed` now tracks `headerUsed` within the safety margin.
- Amend ADR 0030 §2.2 weight-table note with the re-verification date and the corrected values.

### Scenario C — No issue → downgrade and document

- No code change. Amend ADR 0030 §2.5 with a short "Ledger audit (M46)" note stating the
  disagreement is the intended conservative-model artifact and **not** a separate ledger.
- The scribe downgrades tech-debt **H4 from HIGH to LOW** (diagnostic-only, no go-live risk)
  with a one-line pointer to this milestone's finding. *(Scribe action at close — not done in
  this plan.)*

> In all three scenarios the deliverable includes the **finding write-up itself** (the I1–I4
> evidence table) recorded in `docs/milestone-log.md`, so the next person never re-runs the
> investigation.

---

## Dispatch waves

1. **bot-engine-nestjs (investigation pass, I1–I4).** Produce the ledger map (I1), the
   read-only header-capture evidence (I2), the local-charge audit (I3), and the I4 verdict.
   **Gate:** the orchestrator reviews the verdict and selects the scenario **before** any code
   wave. If the verdict needs an ADR-shape change (Scenario A), dispatch the **architect**
   first to amend ADR 0030.
2. **bot-shared-maintainer** — *only if* the verdict surfaces a shared-contract need (e.g. a
   new health-snapshot field or alert type). Expected: **none**. Skip otherwise.
3. **bot-engine-nestjs (implementation)** — the single scenario-selected change above
   (A: bucket split, B: weight recalibration, C: no code — skip this wave).
4. **bot-qa-engineer** — adversarial + boundary tests for the chosen scenario:
   - **A:** market-data calls debit only the new bucket; account calls debit only
     `REQUEST_WEIGHT_1M`; each header reconciles its own bucket; a near-cap on either bucket
     fails-fast/awaits independently; `snapshot()` reports both.
   - **B:** corrected weights produce `localUsed` within margin of a simulated `headerUsed`;
     the unknown-operation throw still fires; directional drift no longer trips in steady state.
   - **C:** add a regression test asserting the safe-direction disagreement stays silent
     (locks the verdict so a future refactor can't reintroduce a false alarm).
5. **bot-review-logic + bot-review-clean-code** — verify the 429/418 freeze, escalation, and
   per-symbol sub-bucket paths are **untouched**; bucket/header mapping is explicit; no order
   path bypasses the gate. (security light — read-only diagnostic, no key/PnL surface; quant
   light — no strategy/PnL math.)
6. **bot-scribe** — ADR 0030 amendment (scenario-dependent), `docs/work-log.md`,
   `docs/milestone-log.md` (the I1–I4 finding table + scenario chosen + reviewer rounds),
   tech-debt **H4** resolution (resolve for A/B, **downgrade to LOW** for C), README status flip,
   and `STATUS.md` rewrite.

> Follow `docs/best-practices/dev-qa-cycle.md`: ≤5 files/items per dispatch, paired tests per
> fix item, architect on any ADR/contract touch, reviewer continuity across rounds, orchestrator
> verifies every diff. Cycle review/fix until zero blockers, zero highs, majority of mediums
> resolved.

---

## Success criteria / verification

- **I4 verdict is documented with evidence** — the I1 ledger map, the I2 live-header capture,
  and the I3 local-charge arithmetic are recorded in `docs/milestone-log.md`; the verdict
  (A/B/C) is unambiguous and cites the Binance doc section.
- **The chosen scenario's deliverable ships and is green** — full `apps/engine` suite passes;
  no regression in the 429/418 freeze, escalation, reconciliation, or per-symbol sub-bucket
  tests.
- **Post-change reconciliation is sane** — in a paper/soak run, the bucket(s) the engine reads
  reconcile against their header(s) within the 80% safety margin; no spurious directional drift
  WARN in steady state; no real-ledger under-count is invisible.
- **tech-debt H4 is resolved or downgraded** — closed (A/B) or moved HIGH→LOW with a finding
  pointer (C). No HIGH go-live blocker remains on this item.
- **No trading-safety invariant is touched** — order path still gates through risk; strategies
  stay pure/deterministic; the diagnostic harness placed/cancelled no orders; no keys or
  balances logged.

---

## Out of scope

- **Multi-instance / shared (Redis-backed) limiter** — that is the M11b topology change
  (ADR 0030 §3 "M11b implication"). M46 stays in-process.
- **WebSocket connection-limit accounting** — explicitly excluded by ADR 0030 §2.1; the WS
  budget is the M1 `MarketDataModule` concern.
- **Real-429 batch/spacing hardening** of the 100-symbol OI & funding bursts (M18 out-of-scope
  LOW). If I2 shows headroom is comfortable this stays deferred; if the audit reveals a genuine
  near-cap on either ledger, raise a **separate** follow-up rather than expanding M46.
- **`AlertTypeEnum.UNHANDLED_EXCEPTION` → dedicated `RATE_LIMIT_DRIFT` type** (M18 out-of-scope
  LOW, shared-enum change) — independent of the ledger question; not pulled in here.
- **Tuning the 80% safety margin or any window/limit constant** beyond correcting a *verified
  stale* per-operation weight under Scenario B.
