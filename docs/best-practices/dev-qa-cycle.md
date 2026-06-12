---
description: Authoritative rules for the development + QA + review cycle. Quality over speed. Smaller iterations. QA is adversarial. Reviewers keep context across rounds. Architect blesses contract touches. Distilled from the M5 retrospective.
globs: "**/*"
alwaysApply: true
---

# Development + QA Cycle — Authoritative Rules

> Quality over speed. Smaller iterations, even if there are more of them. These rules
> apply to every non-trivial change. Where they conflict with general agent dispatch
> heuristics, **these win**.

## Why this exists

The M5 review cycle took 5 rounds to converge. Root cause was not the domain difficulty
— it was process: dispatches too broad, QA too shallow, no architect-in-the-loop on
contract drift, and reviewer context starting cold every round. Each broad fix wave
introduced new defects. This document encodes the corrective rules so M6+ converges
in 2–3 rounds instead of 5.

The trade-bot project has zero tolerance for state-machine bugs going live (phantom
positions, duplicate-fire, drift swallowed silently). Cycling one extra review round
is cheap; shipping a known-broken state machine is catastrophic. **Optimize for
correctness, not throughput.**

## 1 — Dispatch scope discipline

### 1.1 Hard cap on items per engine dispatch
- **≤ 5 must-fix items** per `bot-engine-nestjs` dispatch.
- **≤ 5 files** modified per dispatch when feasible.
- If the punch list is bigger, split into sequential waves with a mini-review between.

### 1.2 Touch the minimum surface
- Fix exactly the items listed; do not refactor "while we're here."
- Each fix should be the smallest change that satisfies the ADR clause / review finding.
- A fix that drags 6 unrelated files in regresses other working parts — proven across
  M5 rounds 1–3.

### 1.3 Architect on contract touches
- If a fix would touch a contract (ADR clause, shared schema, event payload shape, an
  invariant on the position state machine), the engineer **must STOP and surface it**
  to the orchestrator. The architect re-blesses the contract (revises the ADR if
  needed) before the engineer proceeds.
- Engineers never re-interpret contracts mid-fix.

## 2 — QA covers happy path AND adversarial; adversarial is the bar for done

### 2.1 Happy-path coverage is necessary but not sufficient
- Every production code path **must** have a happy-path test. This is the
  regression backbone — without it, future refactors break things silently.
- Happy-path alone is **not** enough to declare QA done. The bar is adversarial
  coverage on top.

### 2.2 Adversarial coverage is the QA bar
Every QA dispatch must additionally cover:

- **Boundary cases:** zero, single, maximum, transitions, negative, empty inputs.
- **Adversarial inputs:** malformed payloads, out-of-order events, race conditions,
  partial failures, retries, drift, missing/duplicate state, exhausted budgets,
  mid-flight halt, schema-constraint violations, crash windows between awaited I/O.
- **Contract violations:** every ADR invariant tested as a failure mode
  (e.g., "no position ever observed unprotected" → simulate a crash between insert
  and arm). If the production code allows the failure, the test fails.
- **Anti-coverage:** assert the code does **not** do what it shouldn't, not only
  what it should.

The mindset shift is: **QA tries to break the implementation**, not confirm it
works. Happy-path is the floor; adversarial coverage is the ceiling. Both ship.

### 2.2 Adversarial failures route to the architect
- When an adversarial QA test fails, the **architect decides next** — not the
  developer.
- The architect classifies the failure as:
  1. **Implementation bug** → delegate to engineer with a minimal-scope fix.
  2. **Contract gap** → revise the ADR first, then dispatch engineer.
  3. **Test-harness fidelity issue** → return to QA for test adjustment.
- This prevents engineers from making local interpretation calls on contract-edge
  failures.

### 2.3 QA at the start of the review wave, not the end
- QA runs **after first engineer implementation** and **before** the multi-reviewer
  parallel wave.
- If QA's adversarial tests catch a class of bug, the reviewers don't need to
  re-discover it from cold reads.

## 3 — Reviewer context continuity

### 3.1 Resume reviewers across rounds
- Round 2+ of any reviewer (security, logic, clean-code, quant) **must be resumed
  via `SendMessage` with the prior round's `agentId`** — not spawned fresh.
- Resuming preserves prior findings, prior reasoning, and prior context. Cold-spawn
  forces the reviewer to re-discover everything from raw diffs.
- Each reviewer's `agentId` is captured at first dispatch and tracked through the
  milestone's review cycle.

### 3.2 QA agent continuity
- Same rule for the QA agent across review rounds. QA remembers prior adversarial
  failures, fixtures, helper patterns. Cold-spawn loses test-suite knowledge.

### 3.3 Architect agent continuity
- Same. Architect resumed across rounds keeps ADR rationale warm and avoids
  re-litigating prior decisions.

## 4 — Definition of done

### 4.1 Build + lint + existing tests is **not** sufficient
- Those gates pass for code that still violates ADR clauses. Green CI ≠ correct.
- For state-machine code (positions, idempotency, reconciliation), require explicit
  assertion that state transitions match the ADR clause cited.

### 4.2 Each fix item needs a paired test
- Each item in a fix-wave dispatch must have a test that **fails before the fix and
  passes after**.
- The engineer's report cites the test name + file:line alongside the implementation
  change.
- If the engineer cannot write such a test (because the bug isn't unit-testable),
  they STOP and surface that to the orchestrator. It's a sign the abstraction is
  wrong.

### 4.3 Punch-list lineage across rounds
- Number every finding as `round X.Y, item Z`.
- Each engineer fix prompt references those item numbers.
- Each reviewer report references those item numbers.
- The orchestrator's consolidation preserves the lineage: "round 3 fixed items 1–7
  from round 2, introduced new items 8–10." Informal synthesis loses precision.

## 5 — Trust but verify (orchestrator side)

### 5.1 After every agent completes
- **Grep the diff** for evidence of each task item before declaring the agent done.
- **Read the actual lines** the agent claims to have changed.
- **Run the build/lint/tests yourself** in the orchestrator session — don't accept
  "build clean" from the agent without verification.
- **Confirm test counts and scenario coverage** numerically.

### 5.2 Common silent failures to check for
- Agent produces a punch list instead of writing files (caught in M5 W1).
- Agent claims tests pre-existing-failed when actually caused by stale fixtures
  (caught in M5 W3).
- Agent reports "build clean" without running it.
- Agent skips items in the prompt silently when prioritizing.

### 5.3 The orchestrator owns the diff
- No round closes until the orchestrator has personally verified the diff matches
  the dispatch intent. Agent summaries describe intent, not reality.

## 6 — Iteration cadence

### 6.1 Smaller iterations preferred
- It is better to dispatch 3 narrow fix waves (5 items each) than 1 broad wave (15
  items). Regression count scales superlinearly with batch size — empirically
  verified across M5 rounds 1–5.

### 6.2 Each round's goal: zero new regressions
- A fix wave is "successful" when it resolves prior findings **and** introduces
  zero new defects.
- M5 round 5 hit this target (4 items, 4 files, 0 new defects). That is the
  steady-state target for all future fix waves.

### 6.3 Cycle until clean
- Continue review/fix rounds until: **zero blockers, zero highs, majority of
  mediums resolved.**
- Acceptable mediums to defer must be explicitly documented in the milestone's
  outcome section with the owning future milestone named (e.g., "BNB→USDT fee
  normalization deferred to M7/M8").

### 6.4 Live-app smoke is mandatory before close

- After the last R-Fix wave passes review, **before the scribe writes the
  outcome section**, the orchestrator MUST boot the actual app against the
  live Postgres container and watch it run for at least **10 minutes**.
- For milestones that ship a new CLI/entrypoint, the orchestrator MUST also
  drive that entrypoint end-to-end at least once (not just argv parsing).
- Any `ERROR`, unhandled rejection, DI cycle / `UndefinedModuleException`,
  missing-module-registration error, boot-pipeline phase failure, or
  reconnect storm → **fix-and-report** before close. Treat the finding at
  the severity it deserves (often `blocker` or `high`).
- Unit + integration tests use isolated Nest module graphs and can hide
  app-wide composition bugs (forwardRef asymmetry, missing module in
  `AppModule.imports`, top-of-file circular imports). M8 caught a real
  `RiskModule ↔ PositionModule` cycle and a missing `BacktestModule` in
  `AppModule` only at this stage.

## 7 — Documentation discipline at close-out

### 7.1 Scribe records the cycle
- Every milestone outcome section records: number of review rounds, blocker/high
  trend per round, total tests added, deferred items with owning milestones.
- This makes the retrospective data available to future planning (e.g., "M5 took 5
  rounds because round 1 dispatched 15 items; M6 capped at 5 and took 3 rounds").

### 7.2 Adversarial test cases inherit forward
- Adversarial tests written during a milestone's QA waves are not deleted at
  close-out — they remain in the regression suite for all future work.

---

## Quick reference for orchestrator dispatch prompts

Every fix-wave dispatch MUST include:

> "Touch the minimum surface (≤ 5 files, ≤ 5 items). If a fix would create a
> contract conflict, STOP and surface it — do not power through. Each item needs a
> paired test that fails before / passes after. Re-read your own diff before
> reporting clean. Verify build + lint + tests yourself."

Every QA dispatch MUST include:

> "Cover the happy path **and** adversarial cases. Happy-path is the regression
> backbone; adversarial coverage is the bar for done. Adversarial means: boundary
> cases, race conditions, drift, mid-flight halt, contract-invariant violations,
> crash windows between awaited I/O. If any adversarial test fails, report to the
> orchestrator for architect routing — do NOT loop back to the developer."

Every reviewer round-2+ dispatch MUST use:

> `SendMessage({ to: '<prior agentId>', message: '...' })` — never a fresh `Agent()`
> spawn.

---

## 8 — Live-memory write protocol (milestone close)

Routing docs only fix the *read* side. At milestone close, the scribe **must** update working memory so agents do not trust stale indexes.

**Single writer = scribe.** Other agents do not edit `STATUS.md`, `plans/README.md` status rows, or the `CLAUDE.md` status pointer.

**Mandatory update step** (same status as "tests green" — a milestone is **not closed** until all four are done):

1. Append the milestone outcome to `docs/milestone-log/archive/M<N>.md` and add its row to the index in `docs/milestone-log.md` (episodic — append only, never edit prior archive files).
2. Overwrite `docs/STATUS.md` (active → new active; last DONE; deploy state; next queue).
3. Flip the milestone row in `docs/plans/README.md` (`ACTIVE` → `DONE`), move plan to `archive/` when Phase 2 layout is active.
4. Replace the `CLAUDE.md` status pointer (no per-milestone paragraph — link to `docs/STATUS.md`).

Agents must not edit episodic memory retroactively, and must not trust working memory that fails the CI staleness guard (`pnpm docs:check:staleness`).
