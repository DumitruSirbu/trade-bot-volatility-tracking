# ADR 0041 — Dependency pinning + provenance for exchange-touching deps

**Status:** Accepted-and-shipped (M14 closed 2026-05-28; §2.4 revised R2-H2)
**Date:** 2026-05-28
**Milestone:** M14 — CI review gate (deterministic gates phase)
**Depends on:** ADR 0039 (CI gate policy), ADR 0040 (SCA + lockfile integrity).
**Consumed by:** M14 W3 (pinning + provenance job), `bot-shared-maintainer` (the `ccxt` pin change).
**Related:** `docs/plans/M14-execution-plan.md` §W3, `docs/plans/00-overview.md` cross-cutting risks ("Order-policy matrix as shared truth"), CLAUDE.md trading-safety invariants.

## 1. Context

`ccxt` is the **only** code that talks to Binance — market data, order placement,
account, and key handling all flow through it. `decimal.js` is the money type that
the *never use floats* invariant rests on. These are the two highest-blast-radius
third-party dependencies in the repo: a malicious or accidentally-broken release of
either is a direct path to wrong orders, leaked keys, or silently-corrupted money
math.

Current state (a problem this ADR fixes):

- `apps/engine/package.json` has **`"ccxt": "^4.5.54"`** — a **caret range**. `pnpm
  update` or a fresh `install` on a cleared store can float `ccxt` to any
  `4.x` ≥ 4.5.54 with no review. For the one dependency that places orders, an
  unreviewed minor bump is unacceptable.
- `decimal.js` is already pinned **exact** (`10.6.0`) in three packages
  (`apps/engine`, `packages/shared`, `packages/analysis`). That is the desired
  posture; this ADR makes it an enforced invariant rather than a coincidence.

The brief mandates: **pin and verify provenance** for the exchange-touching deps.
"Pin" = exact version, no range. "Verify provenance" = assert the installed artifact
is the authentic publisher's artifact, via the integrity hash already in the
lockfile plus npm **provenance attestations** where the publisher ships them.

## 2. Decision

### 2.1 The exchange-touching dependency set

A named, versioned-in-this-ADR list (the gate reads it from a small in-repo manifest
so the list itself is reviewable — `.github/exchange-critical-deps.json`):

- **`ccxt`** — exchange I/O, orders, keys. **Highest criticality.**
- **`decimal.js`** — money type. Correctness-critical.
- **`pg`** — the DB driver carrying every persisted money value and the auth tables.
  Included because a tampered driver could exfiltrate credentials or corrupt
  `NUMERIC` round-trips.

The list is intentionally small and explicit. Adding a dependency to it is a
deliberate, reviewed act (it tightens the gate). Removing one requires
security-reviewer sign-off (it loosens the gate) — called out in W4.

### 2.2 Exact-pin enforcement (deterministic gate)

The required `dependency pinning` check (ADR 0039 §2.2) fails the PR if **any**
dependency on the §2.1 list appears in **any** workspace `package.json` with a
non-exact specifier. "Exact" means a bare semver (`4.5.54`), not `^`, `~`, `>=`,
`*`, `x`, a tag (`latest`, `next`), or a URL/git spec. The check:

1. Reads `.github/exchange-critical-deps.json`.
2. Greps every `apps/*/package.json` and `packages/*/package.json`
   `dependencies`/`devDependencies` for those names.
3. Fails (`UNPINNED_EXCHANGE_DEP`) on any non-exact specifier, naming the offending
   file + line.

**Immediate consequence (W3 deliverable, routed through `bot-shared-maintainer`):**
`apps/engine`'s `ccxt` spec changes from `^4.5.54` to exact `4.5.54`, and the
lockfile is regenerated. This is a shared-contract-adjacent change (it pins the only
exchange client) so it goes through the shared-maintainer per CLAUDE.md hard rule 5.

### 2.3 Cross-workspace version-consistency

For deps on the §2.1 list that appear in more than one workspace (`decimal.js` is in
three), the gate also fails (`EXCHANGE_DEP_VERSION_SKEW`) if the pinned versions
disagree across workspaces. A money-type version skew between `@bot/shared` and
`@bot/engine` could produce subtly different rounding on the same value — exactly the
class of silent money bug the project forbids. One pinned version, everywhere.

### 2.4 Provenance verification

**R2-H2 adjudication (chosen: layer-1 integrity hash is the binding gate; layer-2
cryptographic signature verification deferred until a pnpm-native path exists).**
The originally specified `pnpm audit signatures` **does not exist in pnpm 9.15.9**:
the `signatures` argument is silently ignored and the command runs an ordinary
vulnerability audit (it prints advisories and exits 0), so the step would *appear* to
pass while verifying **zero signatures** — a false provenance guarantee, the exact
dishonesty this project forbids on the order-placing dependency. The npm substitute
(`npm audit signatures`) reads an npm-shaped lockfile (`package-lock.json` /
`node_modules/.package-lock.json`) that this pnpm-only repo does not have; feeding it
a throwaway `npm install --package-lock-only` lock would verify *npm-resolved*
versions that need not match the *pnpm-resolved* tree — an unverified guarantee. Both
are rejected: a gate whose pass/fail is unverified is worse than no gate. The
provenance design is therefore two parts — one binding gate and one advisory log:

1. **Integrity hash (always-on, load-bearing — the binding authenticity gate).**
   Every install in CI runs under `--frozen-lockfile` (ADR 0040 §2.3); the lockfile's
   per-package `sha512` integrity hash is verified on fetch. For the §2.1 deps this
   means the installed `ccxt` / `decimal.js` / `pg` tarball is byte-identical to the
   one that was reviewed when the lock was last regenerated. A substituted artifact
   fails install. This is the guarantee that holds regardless of publisher tooling,
   and it is the **sole load-bearing provenance control** in M14.

2. **Provenance-attestation *lookup* (advisory, non-blocking, honest).** For each
   §2.1 dep at its pinned version the job records — for the operator's awareness, in
   the log only — whether the registry publishes a Sigstore-backed provenance
   attestation:

   ```
   npm view <dep>@<version> --json   # read dist.attestations; no install, no lock needed
   ```

   - Attestation present → log `PROVENANCE_ATTESTATION_PRESENT <dep>@<version>`.
   - Attestation absent (common for established packages today) → log
     `PROVENANCE_ATTESTATION_ABSENT <dep>@<version>`.

   This step **never fails the gate** and makes **no cryptographic verification
   claim** — it does not validate the attestation, only reports its existence. It is
   honest precisely because its pass/fail does not pretend to a guarantee it cannot
   make. Cryptographic signature/attestation *verification* (the layer that would
   prove *who built it and from what source*) is **explicitly deferred** until pnpm
   ships a native verifier, or until a deploy-time Sigstore policy step exists (M15
   cloud go-live — Alternative E). Until then, layer 1 is the authenticity authority.

This means: the integrity hash is the load-bearing guarantee that the installed §2.1
artifact is byte-identical to the reviewed one; the attestation lookup is a visibility
aid, not a gate, and is documented as a **known limitation** rather than dressed up as
a verification step.

### 2.5 Pin-change review gate

Because the §2.1 deps are the highest-blast-radius dependencies, **any PR that bumps
a pinned version of one of them** (detected by the job: the spec changed for a §2.1
dep) is flagged for the **security reviewer** (W4) and the PR must record, in its
description, (a) the upstream changelog/release link and (b) a one-line statement
that the diff was reviewed for order-path / key-handling changes. The gate cannot
mechanically prove a human read the changelog, so it surfaces the flag; the
branch-protection "require conversation resolution" (ADR 0039 §2.6) gives the human
control a place to land. This is the one spot where M14's deterministic gate hands
off to a required human acknowledgment rather than a machine pass/fail.

### 2.6 What this ADR does NOT do

- Does NOT pin every dependency in the repo to exact versions. Only the §2.1
  exchange-touching set is gated; the rest follow the existing manifest conventions
  (most are already exact, but that is not enforced here).
- Does NOT vendor (`patch`/`pnpm patch`) `ccxt`. The pin + integrity hash is
  sufficient; vendoring would fork the dependency and defeat upstream security
  fixes.
- Does NOT replace ADR 0040's SCA gate. A pinned dep can still develop a known
  vulnerability; 0040 catches that, 0041 catches authenticity + pinning.

## 3. Consequences

**Positive.**

- `ccxt` can no longer float to an unreviewed minor/patch — the one dependency that
  places real orders is pinned and its bumps are reviewer-flagged.
- A substituted or tampered `ccxt`/`decimal.js`/`pg` tarball fails the install gate
  (the `sha512` integrity hash) — this is the binding authenticity guarantee.
- `decimal.js` version skew across workspaces — a silent money-rounding hazard — is
  caught deterministically.
- The gate is data-driven (`.github/exchange-critical-deps.json`), so tightening
  (adding a dep) or loosening (removing one) the critical set is itself a reviewed,
  versioned change.

**Negative.**

- Exact-pinning `ccxt` means security patches require a deliberate PR rather than
  floating in. Mitigation: that is the intended trade-off — for the order-placing
  dependency, a reviewed bump is the correct cost; the SCA gate (0040) will *fail*
  on a known-vulnerable pinned version, forcing the bump promptly.
- Cryptographic signature/attestation *verification* is deferred (R2-H2): pnpm
  9.15.9 has no native `audit signatures`, and the npm substitute needs an npm-shaped
  lockfile this repo does not produce. Layer 2 is therefore an advisory log, not a
  verification gate. Mitigation: layer 1 (the `sha512` integrity hash) is the binding
  authenticity guarantee and fully covers the "is this the reviewed artifact" question;
  the deferred verification only adds "who built it, from what source," which is
  hardening, not the load-bearing control. Revisit when a pnpm-native verifier or an
  M15 deploy-time Sigstore policy exists (Alternative E).

**Neutral.**

- The attestation lookup (`npm view <dep>@<version> --json`) reads registry metadata
  without an install or lockfile, so it works on a pnpm-only tree; it never gates the
  PR and is logged for the operator's awareness only.

## 4. Alternatives considered

- **A. Leave `ccxt` as a caret range, rely on the lockfile to freeze it.** Rejected:
  the lockfile freezes the *current* resolution, but `pnpm update` / a manifest edit
  can re-float within the caret without a manifest diff that signals "exchange dep
  changed." An exact pin makes the manifest itself the reviewable record.
- **B. Pin every dependency exact, repo-wide.** Rejected for M14: high churn, large
  diff, and most of the value is concentrated in the three §2.1 deps. The lockfile
  already freezes resolutions for the rest; the SCA gate covers their vulnerabilities.
- **C. Hard-fail on provenance-attestation absence.** Rejected: attestations are
  publisher-opt-in; many established, safe packages (including possibly the pinned
  `ccxt`/`decimal.js` versions) do not ship them yet. Hard-failing absence is
  undeployable today and pressures engineers to drop critical deps. Absence falls
  back to the integrity hash; only a *failed* attestation hard-fails.
- **D. Vendor/patch `ccxt` into the repo.** Rejected: forks the dependency, blocks
  upstream security fixes, and bloats the tree. Pin + integrity hash gives the
  authenticity guarantee without forking.
- **E. A SaaS / deploy-time provenance tool (Sigstore policy-controller, cosign
  attestation verify, etc.).** Rejected for M14: adds vendor + secret surface, and the
  lockfile `sha512` hash already binds authenticity to the reviewed artifact. This is
  the chosen home for the deferred cryptographic signature *verification* (R2-H2):
  revisit at M15 cloud go-live, where a deploy pipeline likely needs SBOM/attestation
  verification anyway and a Sigstore step can verify the pnpm-resolved artifacts
  directly.
- **G. Run `pnpm audit signatures` (or an `npm audit signatures` substitute) as a
  blocking provenance gate.** Rejected (R2-H2): `pnpm audit signatures` does not exist
  in pnpm 9.15.9 — the `signatures` arg is silently ignored and a normal vulnerability
  audit runs (exit 0), so the step would falsely appear to pass while verifying no
  signatures. `npm audit signatures` needs an npm-shaped lockfile this pnpm-only repo
  lacks; synthesizing a throwaway `package-lock.json` would verify npm-resolved
  versions that need not match the pnpm tree — an unverified guarantee. A gate whose
  result is unverified is worse than none; layer-1 integrity hash carries authenticity
  and cryptographic verification is deferred (Alternative E).
- **F. No version-consistency check, allow per-workspace `decimal.js` versions.**
  Rejected: divergent money-type versions risk inconsistent rounding on the same
  value across the engine/shared/analysis boundary — a silent correctness bug the
  project's float-free invariant exists to prevent.

## 5. References

- `docs/plans/M14-execution-plan.md` §W3 (pinning + provenance job, deps manifest,
  `ccxt` pin change via shared-maintainer).
- ADR 0039 §2.2 (required-check set), §2.6 (conversation-resolution control used by
  the pin-change review).
- ADR 0040 §2.3 (lockfile integrity-hash layer this ADR's provenance layer 1 reuses).
- CLAUDE.md trading-safety invariants ("money is decimal, never float"; "exchange
  keys least-privilege"); `docs/plans/00-overview.md` cross-cutting risk
  "Order-policy matrix as shared truth".
- pnpm CLI: `--frozen-lockfile` integrity verification (layer-1 binding gate);
  `npm view <dep>@<version> --json` → `dist.attestations` (advisory provenance lookup,
  non-blocking). Note: pnpm 9.15.9 has no `audit signatures` subcommand (R2-H2) —
  cryptographic signature verification is deferred per §2.4 + Alternative E.
