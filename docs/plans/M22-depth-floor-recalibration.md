# M22 — Depth-floor recalibration (book-consumption-anchored COIN_DEPTH_FLOOR_10BPS_USDT)

> **Sequencing note:** M22 lands **after** M19 (which introduced the per-coin depth guard,
> `COIN_DEPTH_FLOOR_10BPS_USDT`, as a tier-keyed eligibility skip in ADR 0004 §6a) and after
> M20/M21 fixed the soak's halt miscalibrations. With the halts no longer permanently tripping,
> the soak finally produced **trade-flow evidence** — and that evidence shows the M19 floors,
> set pre-soak as conservative round numbers, are themselves now the dominant blocker. M22 is a
> standalone risk-loosening mini-milestone: it recalibrates the three depth floors to
> position-size-anchored values validated against soak rejections. Decision by architect + quant
> review, 2026-06-04 (both APPROVE-WITH-AMENDMENTS).

## Context

`COIN_DEPTH_FLOOR_10BPS_USDT` (ADR 0004 §6a, M19) rejects any candidate coin whose one-sided
resting 10bps book depth is at/below a tier-keyed floor, with reject reason `coin_book_too_thin`.
M19 set those floors to **conservative round numbers** — tier1 $20,000 / tier2 $10,000 /
tier3 $5,000 — explicitly **not** derived from a depth-vs-slippage relationship. They were a
safe placeholder until soak evidence existed.

During the M19/M20/M21 paper-soak window (2026-06-03 → 2026-06-04), after the halt
miscalibrations were fixed, analysis of **2026-06-04**'s decisions showed **10
`coin_book_too_thin` rejections**. The observed depths ranged from **$529 to $9,174**. Critically,
**7 of the 10** were blocked by floors that are **4–80× the max order size**: the engine is
running at $500–1,000 capital with `MAX_EXPOSURE_PER_COIN_USDT = 250` (the hard per-coin notional
cap). A $250 order does not need a $10,000–$20,000 resting book to fill within modeled slippage.

**The correct anchor (architect review) is the book-consumption ratio:** what fraction of the
resting one-sided 10bps book does a max-size order consume? `book_depth_10bps_usdt` is one-sided
resting notional within 10bps of mid (ADR 0001 line 289). The floor should be chosen so that a
max-size order — up to `MAX_EXPOSURE_PER_COIN_USDT` — consumes a **small, bounded fraction** of
that resting top-of-book.

| Anchor                        | Floor    | Max order | Book consumption |
|-------------------------------|----------|-----------|------------------|
| OLD tier1                     | $20,000  | $250      | 1.25% (absurdly conservative) |
| OLD tier2                     | $10,000  | $250      | 2.5% (= new tier1 — no reason for tier2 to match tier1 strictness) |
| NEW tier1                     | $10,000  | $250      | 2.5% (conservative) |
| NEW tier2                     | $2,500   | $250      | 10% (acceptable) |
| NEW tier3                     | $2,000   | $250      | 12.5% (acceptable for tier3) |

### Agreed numbers (architect + quant, 2026-06-04)

| Tier  | Current | New     |
|-------|---------|---------|
| tier1 | $20,000 | $10,000 |
| tier2 | $10,000 | $2,500  |
| tier3 | $5,000  | $2,000  |

**Why tier1 $10,000 and not $5,000.** Today's soak showed MAGMA ($529 depth) and H ($5,380 depth)
**volume-mis-ranked as tier1** — coins ranked tier1 by 24h volume despite thin books. A $5,000
tier1 floor would *pass* H, a coin with no business getting tier1 treatment. $10,000 is
**non-binding for any genuine tier1 coin** (BTC/ETH 10bps depth is hundreds of thousands of USDT)
yet filters volume-mis-ranked impostors. It is a cheap defence against the separate (out-of-scope)
volume-only tier-ranking weakness.

**Why tier3 $2,000 and not $1,000.** A $250 order into a $1,000 one-sided book consumes ~25% of
one-sided depth → ~5bps entry slippage, and tier3 alts are exactly the coins whose books
**evaporate on a stop-loss exit**. $2,000 holds consumption at ~12.5% one-sided (~2.5bps entry),
keeping a margin against the exit-gap risk the entry-depth metric does not measure.

**Why tier2 $2,500.** ~10% book consumption, ~2bps entry slippage — sound. There is no reason a
tier2 coin should be held to tier1 strictness (the old $10,000 was a 2.5%-consumption floor
identical to the new tier1 floor).

### Soak evidence (2026-06-04)

10 `coin_book_too_thin` rejections. At the amended floors:

- **7 unblocked** (depths **$3,468–$9,174** — tier1/tier2 coins with real books that the old
  floors over-rejected).
- **3 correctly still blocked** (depths **$529, $681, $2,321** — genuinely illiquid; rejected at
  the new floors too).

This continues M19/M20/M21's **code-only, migration-free** discipline: the change is a const swap
plus a comment-block update plus an in-place ADR §6a amendment. No DB write, no schema change.
Only an engine restart is required to pick it up.

> **This is a risk-loosening change — keep that framing explicit.** M22 *lowers* three floors, so
> it admits coins the old floors rejected. That is the **intended** correction (the old floors
> were 4–80× the order size on 7 of 10 rejections), not a regression — but a loosening of a risk
> gate deserves its own visible review trail, which is why M22 is a standalone milestone rather
> than a silent const tweak. The 14-day post-deploy slippage telemetry below exists precisely
> because **one calm day of 10 rejections is enough to prove the current floors wrong, but not
> enough to prove these new floors optimal.** Ship as a correction; gather the slippage
> distribution; re-calibrate against it before any scale-up.

## Scope

1. **Recalibrate the floors** in `apps/engine/src/risk/const/riskConsts.ts`: swap
   `COIN_DEPTH_FLOOR_10BPS_USDT` to `{ TIER_1: 10_000, TIER_2: 2_500, TIER_3: 2_000 }`, and
   **rewrite the comment block** to record the book-consumption-ratio anchor, the soak evidence,
   and the per-tier rationale (replacing the M19 "conservative round numbers" framing).
2. **ADR 0004 §6a in-place amendment:** update the floor table and rationale; **supersede** the
   M19 language that calls these "reasonable round numbers, not derived from a depth-vs-slippage
   relationship" with the new **book-consumption-ratio** anchor framing; record the 2026-06-04
   soak evidence; add the post-deploy 14-day slippage-telemetry requirement as a §6a calibration
   condition.
3. **QA — paired boundary tests per tier:** correct reject **at/below** each new floor; pass
   **above** each floor; a **regression-proof** case that the old floors would have *incorrectly*
   blocked today's unblocked coins ($3,468–$9,174); and that the inclusive `<=` boundary
   semantics are preserved (depth `<=` floor → reject).
4. **Tech-debt entries (two new MEDIUM):** volume-only tier ranking (ranks MAGMA/H as tier1 by
   24h volume despite thin books); entry-vs-exit depth gap (`book_depth_10bps_usdt` does not proxy
   exit liquidity — a coin can pass entry and gap on stop-loss exit when the book thins).
5. **Docs:** `docs/tech-debt.md` — **rewrite/close the existing M19 "not empirically calibrated"
   MEDIUM row** (superseded by M22's evidence-based floors; repoint it to §6a + the 14-day
   telemetry) **and add two new MEDIUM entries** (volume-only tier ranking; entry-vs-exit depth
   gap) — never leave three overlapping depth-calibration rows. Also `docs/work-log.md`,
   `docs/milestone-log.md`, CLAUDE.md status line, `docs/plans/00-overview.md` RiskModule note.

**Out of scope:**
- Changing the tier-ranking logic (volume-only ranking is logged as MEDIUM tech-debt, not fixed in M22).
- Exit-liquidity-aware position sizing (logged as MEDIUM tech-debt, not built in M22).
- Any change to the spread ceiling, OI, funding, breadth, or index-shock thresholds.
- Any DB migration or `strategy_versions` write.

## Boundary and measurement semantics (lock before QA)

- **Inclusive `<=` boundary.** The M19 guard rejects when `depth <= floor` (depth at exactly the
  floor → `coin_book_too_thin`). M22 **keeps that convention** — do not flip to `<`. QA asserts:
  at exactly the floor → reject; one cent above → pass. State this in the §6a amendment so a future
  operator reading a depth that equals a floor is not surprised it was rejected.
- **One-sided resting 10bps notional, not two-sided.** `book_depth_10bps_usdt` is the **one-sided**
  resting notional within 10bps of mid (ADR 0001 line 289). All book-consumption ratios in this
  plan and in §6a are computed against **one-sided** depth (a $250 order vs a $2,500 one-sided book
  = 10%). The §6a amendment must say "one-sided" in words so the ratios are not misread as
  two-sided.
- **Fail-closed parse preserved.** M19 parses the depth via `parseMoney` inside a try/catch and
  **fails closed** (rejects `coin_book_too_thin`) on an unparseable depth. M22 changes only the
  numeric floors — it must **not** alter the fail-closed parse path. QA confirms the fail-closed
  behaviour still holds after the const change.

## Change set

| Workspace        | Files (representative)                                                                 | Item |
|------------------|---------------------------------------------------------------------------------------|------|
| `apps/engine/`   | `src/risk/const/riskConsts.ts` (swap `COIN_DEPTH_FLOOR_10BPS_USDT` values; rewrite comment block with book-consumption anchor + soak evidence) | 1 |
| `apps/engine/` (tests) | the per-coin depth-guard spec (paired boundary tests per tier; regression-proof that old floors blocked the unblocked coins; `<=` boundary; fail-closed parse intact) | 3 (QA) |
| docs             | ADR 0004 §6a in-place amendment; `docs/tech-debt.md` (volume-only tier ranking MEDIUM, entry-vs-exit depth gap MEDIUM) | 2,4 |

No dashboard work this milestone (no new reject reason — `coin_book_too_thin` already exists from
M19; no new funnel surface). No `packages/shared/` change (the floors are engine-side risk config,
ADR 0004 Conflicts #1). No `apps/mcp` / `apps/agent` touch.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`**: amend **ADR 0004 §6a in place**. The amendment must:
   - Replace the floor table with `{ tier1: 10_000, tier2: 2_500, tier3: 2_000 }`.
   - **Supersede** (replace, not append) the M19 "reasonable round numbers, not derived from a
     depth-vs-slippage relationship" language with the **book-consumption-ratio** anchor: the floor
     is chosen so a max-size order (up to `MAX_EXPOSURE_PER_COIN_USDT`) consumes a small, bounded
     fraction of the **one-sided** resting 10bps book (tier1 2.5%, tier2 10%, tier3 12.5%).
   - Record the per-tier rationale (tier1 $10k filters volume-mis-ranked impostors yet is
     non-binding for real tier1; tier2 $2.5k ≈ 2bps; tier3 $2k holds ~12.5% one-sided / ~2.5bps and
     guards the exit-gap risk that $1k would not).
   - Record the **2026-06-04 soak evidence** (10 rejections; 7 unblocked at $3,468–$9,174; 3 still
     blocked at $529/$681/$2,321).
   - State the **inclusive `<=` boundary** and **one-sided** measurement semantics in words.
   - Add the **14-day post-deploy slippage-telemetry requirement** as a §6a calibration condition
     (the floors are a correction validated on one calm day, re-calibrated against the realized
     slippage distribution before scale-up).
   - **Note** the two MEDIUM tech-debt items §6a depends on (volume-only tier ranking; entry-vs-exit
     depth gap) and that `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` is the only reactive backstop for the
     latter.
   - **One-line drift fix, no design change (while editing §6):** §6b still documents
     `STRESS_BREADTH_DISTANCE_PCT = 30` but `riskConsts.ts` has been updated to **40** (a June
     hotfix). Update §6b from 30 to 40 (or add "see code") in the same edit session so §6 does not
     hold two sources of truth. This is purely a documentation sync — no behaviour or M22 design change.

   Inline §6a values would drift from code if not updated together, so the architect amendment
   **lands before** the engine code and the const-comment and §6a table must agree.
2. **Serial — `bot-engine-nestjs`**: in `riskConsts.ts`, swap `COIN_DEPTH_FLOOR_10BPS_USDT` to
   `{ [TIER_1]: 10_000, [TIER_2]: 2_500, [TIER_3]: 2_000 }` and **rewrite the comment block** to
   carry the book-consumption-ratio anchor, the soak evidence, and the per-tier rationale (drop the
   M19 "round numbers" framing). Do **not** touch the depth-guard logic, the `<=` boundary, or the
   fail-closed `parseMoney` path. Single small dispatch (one file, one const + its comment).
3. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - **Per-tier boundary (all three tiers):** depth **at** the new floor → `coin_book_too_thin`
     reject (inclusive `<=`); depth one cent **above** the floor → pass the depth guard.
   - **Regression proof (the load-bearing test):** today's unblocked coins ($3,468–$9,174 at their
     real tiers) **pass** at the new floors, and would have been **rejected** at the old floors —
     assert both, so a future revert to the old numbers fails this test.
     - **Use the actual `(symbol, coinTier, depth)` tuples from the 2026-06-04 soak decisions** —
       export or hard-code the 10 reject rows into the spec as named examples. Do **not** pick
       "tier2 and any depth in range"; pin each depth to the **actual tier the engine assigned that
       day**. Volume-only ranking is the trap: a coin's tier is not inferable from its depth.
     - Call out the **H** edge case explicitly: H had depth **$5,380** and was mis-ranked **tier1**,
       so it belongs in the **still-blocked** set and must **still reject** at the tier1 floor
       $10,000 — testing $5,380 at tier2 would wrongly pass and miss the tier1 floor behaviour.
   - **Still-blocked proof:** the three genuinely-illiquid depths ($529, $681, $2,321) **still
     reject** at the new floors — again at their **actual soak tiers**, alongside H ($5,380, tier1).
   - **Fail-closed preserved:** an unparseable / non-finite depth still rejects `coin_book_too_thin`
     (the M19 fail-closed parse path is unchanged by the const swap).
   - Update any fixture/comment referencing the old $20k/$10k/$5k floors.
4. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code`
   + **`bot-review-quant`**. The quant reviewer owns the calibration: confirm the **book-consumption
   ratios are consistent across tiers** (tier1 2.5% / tier2 10% / tier3 12.5% against a $250
   max-size order on a one-sided book), that the 7-unblocked / 3-still-blocked soak split holds at
   the chosen floors, and that the **14-day slippage-telemetry plan is present** in both §6a and the
   Verification section. Cycle fix → re-review until zero blockers, zero highs, majority mediums.
5. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` RiskModule note (depth floors recalibrated to book-consumption
   anchor), and confirm the ADR 0004 §6a amendment is linked.
   - **`docs/tech-debt.md` — update first, then add (must NOT leave three overlapping depth rows):**
     1. **Close or rewrite the existing M19 MEDIUM row** ("Per-tier book-depth floors not empirically
        calibrated…", ~line 24). M22's evidence-based floors supersede it — replace it with the
        book-consumption anchor and a pointer to ADR 0004 §6a + the 14-day post-deploy telemetry.
     2. **Then add the two new MEDIUM entries** as distinct items: volume-only tier ranking;
        entry-vs-exit depth gap. The result is **one** superseded/rewritten row plus two new rows —
        never three overlapping depth-calibration MEDIUM lines.
   Record the
   **stale-state / restart outcome** (whether a stale `coin_book_too_thin`-driven skip needed any
   action — none expected, the depth guard is a per-decision eligibility skip, not a persisted
   day-halt) and the dump path.

Orchestrator verifies the actual diff after every wave (agent summaries describe intent, not
reality) — and **explicitly diffs the const values *and* the comment block** to confirm both the
numbers and the rationale text landed, and that the §6a table matches the const.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M22 is code-only and migration-free** — no schema change, no `strategy_versions` write, no DB
touch at all. The depth floors are operator-level risk config (ADR 0004 Conflicts #1), not a DB
column. Picking up the change requires only an **engine restart**. No `-v`, no down/revert on the
live soak.

**Backup rotation:** before the engine restart, take a routine `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`,
into the gitignored `backups/` folder). **Keep the 2 most recent `backup_` files; prune older
ones** to bound disk use. Show the user the dump path before restarting.

> **No stale-halt class here.** Unlike M19/M21's market-stress day-halt (a persisted `risk_state`
> row that survives a restart until UTC rollover), `coin_book_too_thin` is a **per-decision
> per-coin eligibility skip** — it is re-evaluated against fresh depth on every signal and is never
> persisted as a halt. So M22 needs **no** `clearHaltForDate` step. Confirm this on inspection
> after restart (`risk_state` should show no depth-driven halt), but no DB write is expected.

## Post-deploy steps (same pattern as M21)

1. Take `pg_dump` before the engine restart (prune to 2-deep `backup_` retention).
2. **Engine restart only** (no migration).
3. Inspect `risk_state` after restart — confirm no stale halt (depth guard is not a halt; nothing
   to clear, but verify read-only).
4. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report any boot error before
   the scribe. Confirm the engine boots and stays running and that previously-blocked tier1/tier2
   coins now clear the depth guard on a calm tape.
5. **Reject-reason funnel mix check (24–48h after restart):** run the **same funnel query used in
   the M19 soak analysis** over the reject-reason distribution. Confirm `coin_book_too_thin`'s
   **share has fallen** relative to the M19/M20/M21 soak baseline, and that other gates (spread,
   funding, stress, slots) have **risen proportionally** as they become the new visible bottleneck.
   This confirms the guard stopped dominating the funnel — it does **not** imply "more trades
   automatically" (admitting more coins past the depth guard only shifts which gate binds next).
   Read-only DB querying; no write.
6. **14-day slippage telemetry (mandatory, not optional — architect + quant):** for 14 days after
   deploy, log per-fill `book_depth_10bps_usdt` at entry (from `decisions.market_snapshot`) and the
   **realized entry/exit slippage** (from `positions`). Watch for fills where **realized slippage >
   modeled** — those signal the floor was set too low for that tier. Track **near-miss bands per
   tier** (depths just above each new floor). Re-calibrate the floors against that realized-slippage
   distribution **before any scale-up**. This is read-only DB querying — no write, no CLAUDE.md
   #8/#9 concern. It **closes the entry-vs-exit-depth-gap MEDIUM tech-debt only after real fills
   validate the floors**, not on deploy.

## Verification

- **Unit:** the per-coin depth-guard suite green; full `src/risk` suite green; `src/backtest` suite
  green (the floors seed the backtest gate too — confirm no replay fixture asserts the old $20k/$10k/$5k
  numbers).
- **Boundary proof:** depth **at** each new floor → reject; one cent **above** → pass; inclusive
  `<=` preserved for all three tiers.
- **Regression proof (load-bearing):** the 7 soak-unblocked depths ($3,468–$9,174) pass at the new
  floors and would have been rejected at the old floors; the 3 still-blocked depths ($529, $681,
  $2,321) still reject.
- **Fail-closed proof:** an unparseable depth still rejects `coin_book_too_thin` (M19 parse path
  unchanged).
- **Boot:** engine boots and stays **running** after restart (no DI/boot error). 10-min live app
  smoke — fix-and-report any boot error before the scribe.
- **Live operation:** previously-blocked tier1/tier2 coins with real books clear the depth guard on
  a calm tape; genuinely-illiquid coins still skip with `coin_book_too_thin`.
- **Reject-reason funnel mix (24–48h after restart):** the M19 soak funnel query shows
  `coin_book_too_thin`'s share **fallen** vs the M19/M20/M21 baseline and other gates (spread,
  funding, stress, slots) **risen proportionally** — confirming the guard no longer dominates the
  funnel, without implying more trades automatically.
- **Post-deploy calibration telemetry (read-only; part of the milestone, not optional):** the 14-day
  per-fill `book_depth_10bps_usdt`-at-entry + realized-slippage log is set up and recording; if any
  tier shows realized slippage > modeled on fills near its floor, revisit that floor **before any
  cloud-soak scale-up** — and revisit against that distribution, not another short calm soak.

## Success criteria

- `COIN_DEPTH_FLOOR_10BPS_USDT` is `{ tier1: 10_000, tier2: 2_500, tier3: 2_000 }` in
  `riskConsts.ts`, with a comment block recording the book-consumption-ratio anchor and soak evidence.
- ADR 0004 §6a amended **in place** with the new floor table, the book-consumption-ratio anchor
  (superseding the M19 "round numbers" framing), the 2026-06-04 soak evidence, the inclusive `<=`
  and one-sided measurement semantics, and the 14-day post-deploy slippage-telemetry requirement.
- Today's **7 unblocked coins** ($3,468–$9,174) pass; the **3 blocked coins** ($529, $681, $2,321)
  still reject — proven by paired tests.
- Paired boundary tests green for all three tiers; inclusive `<=` and fail-closed parse preserved.
- 14-day post-deploy slippage-telemetry plan recorded.
- Two new MEDIUM tech-debt entries added (volume-only tier ranking; entry-vs-exit depth gap).
- Zero blockers, zero highs at close. M22 is migration-free.

## Explicitly deferred

- **Volume-only tier ranking (MEDIUM tech-debt).** Coins are tiered by 24h volume, which ranked
  MAGMA ($529 depth) and H ($5,380 depth) as tier1 despite thin books. M22's $10k tier1 floor is a
  cheap defence against the *symptom* (it filters the impostors at the depth guard), but the
  *ranking* itself is wrong. Logged as MEDIUM for a future tier-ranking fix (e.g. depth-aware or
  blended ranking) — not a go-live blocker, and out of scope here.
- **Entry-vs-exit depth gap (MEDIUM tech-debt).** `book_depth_10bps_usdt` measures **entry**
  liquidity and does **not** proxy exit liquidity — a coin can pass the entry depth guard and then
  **gap on a stop-loss exit** when its book thins. The only reactive backstop today is the
  `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` kill switch. Logged as MEDIUM for future exit-liquidity-aware
  position sizing. The 14-day post-deploy slippage telemetry begins gathering the evidence to size
  this fix; the tech-debt item closes only when real fills validate the floors.

---

## Review Synthesis

Two independent senior reviews of this recalibration — **architect** and **quant** — were read in
full and synthesised here (decision 2026-06-04). Both returned **APPROVE-WITH-AMENDMENTS** — no
blockers, agreement that the M19 round-number floors are demonstrably wrong against soak evidence,
that the **book-consumption ratio** is the correct anchor, that the change is correctly code-only
and migration-free, and that a risk-loosening change of this kind warrants a standalone milestone
with a visible review trail and mandatory post-deploy telemetry.

### Incorporated (both reviewers)

- **Book-consumption-ratio anchor replaces the M19 "round numbers" framing.** The floor is chosen
  so a max-size order (up to `MAX_EXPOSURE_PER_COIN_USDT = 250`) consumes a small, bounded fraction
  of the one-sided resting 10bps book (tier1 2.5% / tier2 10% / tier3 12.5%). Folded into Context,
  the §6a amendment requirements, and the const comment-block rewrite.
- **Ship as a correction, not an optimum.** One calm day (10 rejections) is enough to call the
  current floors wrong, not enough to call the new floors optimal. Both reviewers require **14-day
  post-deploy slippage telemetry** before scale-up — added to Post-deploy steps, Verification, and
  the §6a amendment as a calibration condition.
- **Migration-free / engine-restart-only confirmed.** Operator-level risk const (ADR 0004 Conflicts
  #1); no schema change, no `strategy_versions` write. Captured in DB safety.
- **In-place §6a amendment in the same wave as the const change.** Inline §6a values would drift
  from code if updated separately; the architect amendment lands before the engine code and the
  orchestrator diffs both for agreement.

### Incorporated (quant)

- **Per-tier rationale lock.** tier1 $10k non-binding for real tier1 but filters volume-mis-ranked
  impostors; tier2 $2.5k ≈ 2bps at ~10% one-sided; tier3 $2k (not $1k) because $1k is ~25%
  one-sided / ~5bps plus exit-gap risk, while $2k holds ~12.5% one-sided / ~2.5bps. Folded into
  Context and the §6a requirements; the quant reviewer re-confirms ratio consistency in wave 4.
- **Entry-depth does not proxy exit liquidity (MEDIUM tech-debt).** A coin can pass entry and gap
  on stop-loss exit; `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` is the only reactive backstop. Logged as
  MEDIUM; the 14-day telemetry begins sizing the eventual exit-liquidity-aware fix.
- **Volume-only tier ranking is a separate weakness (MEDIUM tech-debt).** It ranks MAGMA/H as tier1
  by 24h volume despite thin books; M22's $10k tier1 floor defends the symptom but not the ranking.
  Logged as MEDIUM, out of scope for M22.

### Incorporated (architect)

- **Standalone mini-milestone with its own review trail.** A risk-loosening change deserves
  visibility — hence M22 rather than a silent const tweak. Stated in the sequencing note and Context.
- **One-sided measurement + inclusive `<=` boundary stated in words in §6a.** `book_depth_10bps_usdt`
  is one-sided resting notional within 10bps of mid (ADR 0001 line 289); the depth guard rejects on
  `depth <= floor`. Locked in Boundary semantics and the §6a requirements so operators read both
  the ratios and the boundary correctly.
- **Post-deploy telemetry is mandatory, not optional**, and **closes the entry-vs-exit-depth-gap
  MEDIUM only after real fills validate the floors** — not on deploy. Captured in Post-deploy steps
  and the deferred-items section.

### Consciously rejected / already covered

- **Tighter tier1 ($5,000).** Rejected — it would pass H ($5,380), a volume-mis-ranked impostor.
  $10k is non-binding for genuine tier1 yet filters impostors.
- **Looser tier3 ($1,000).** Rejected — ~25% one-sided consumption / ~5bps entry plus exit-gap risk
  on exactly the coins whose books evaporate on a stop. $2,000 holds ~12.5% one-sided.
- **Fixing the tier-ranking logic or building exit-liquidity-aware sizing now.** Both deferred as
  MEDIUM tech-debt — real fixes that deserve their own milestones and the slippage distribution M22
  starts gathering, not a same-wave bolt-on to a const recalibration.
- **Any schema migration / `strategy_versions` write.** Out of scope by design (migration-free); no
  reviewer asked to add one.
