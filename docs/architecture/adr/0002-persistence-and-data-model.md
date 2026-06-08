# ADR 0002 — Persistence & data model (M2)

Status: Accepted
Date: 2026-05-22
Milestone: M2 — Persistence & data model

## Context

M2 turns the in-memory M1 pipeline into a durable backtest dataset and lays the full
relational schema for every later milestone. Thirteen tables must exist as reversible
migrations: `instruments`, `candles`, `tick_aggregates`, `universe_membership`,
`funding_rates`, `open_interest`, `book_snapshots`, `strategy_versions`, `positions`,
`transactions`, `decisions`, `risk_state`, `account_snapshots`. Market data (1m + 5m
candles, sub-minute aggregates, OI, funding, instrument metadata, point-in-time
membership including tier changes) must begin accumulating continuously and faithfully
enough to reconstruct a live trigger in M7. `decisions.market_snapshot` must be a
Zod-validated JSONB payload. `positions` carries entry-time (immutable) and lifetime
(mutable) instrumentation columns. `strategy_versions` seeds v0–v3 with canonical params.

Constraints that shape every decision below:

- **Money is `decimal`, never float** — already enforced in code via `MoneyValue`
  (decimal.js) and `parseMoney`/`formatMoney` (`common/utils/money.ts`). NUMERIC columns
  must reach JS as `MoneyValue` and reach the driver as `string`, never as a JS `number`.
- The M1 groundwork is fixed: `dataSourceOptions.ts` discovers entities by the glob
  `**/entity/*.{ts,js}` across the whole engine `src`, `synchronize` is hard-off,
  `migrationsTransactionMode` is `'each'`. `BaseRepository<T>` assumes a numeric `id` PK.
- code-conventions is **authoritative**: each module owns its own entities (registered in
  that module's `TypeOrmModule.forFeature`), one repository per entity extending
  `BaseRepository`, no repository barrel, migration naming `YYYYMMDDHHMMSS-Name.ts`,
  reversible `down()`, explicit `onDelete`/`onUpdate`, constants in a module `const/` folder.
- **No look-ahead / survivorship bias**: membership and funding must be point-in-time;
  the backtest replays the universe and funding as they *were*.
- Persistence is a **passive subscriber**. It must never sit in the order path, never call
  strategy/risk, and must be idempotent on its UNIQUE constraints (duplicate-key →
  warn + return, per conventions).
- `decisions` / `positions` / `transactions` have **no live writer until M3–M6**. M2
  creates their schema + repositories + the `market_snapshot` Zod hook only.

## Decision

### 1. Entity-ownership model — domain-owned entities, infra-only PersistenceModule

The apparent conflict (overview names a single "PersistenceModule" owning all
entities/repositories/migrations; code-conventions says "each module owns its own
entities") is **resolved in favour of code-conventions**: it is authoritative and the
`dataSourceOptions` entities glob (`**/entity/*.{ts,js}`) already discovers entities
*wherever* they live, so domain-owned `entity/` folders cost nothing at the DataSource
level. The overview's "PersistenceModule owns entities/repositories/migrations" line is
re-read as **infra ownership**, not file ownership: PersistenceModule owns the
*cross-cutting persistence machinery*, not every table's class. (This is a re-reading,
not an override — surfaced to the main session in the report; it does not contradict any
conventions rule, and the overview text should be reconciled by the scribe.)

**PersistenceModule (thin, cross-cutting infra only) owns:**

- the NUMERIC↔decimal `ValueTransformer` (§2) — but this lives under `common/` so it is
  importable without a module dependency cycle; PersistenceModule re-exports nothing it
  does not own.
- migration tooling/anchor only. Migrations already live centrally in
  `src/database/migrations/` (a single ordered timeline is correct — one schema, one
  history); PersistenceModule does **not** duplicate them per domain.
- it registers **no** `forFeature` entities and owns **no** repository. It is essentially
  a documentation/grouping seam plus the DataSource/migration wiring already in
  `src/database/`.

**Per-entity ownership for M2** (table → owning module → `entity/` location → repository):

| Table | Owning module | Entity location (M2) | Repository |
|---|---|---|---|
| `instruments` | MarketDataModule | `market-data/entity/` | `InstrumentRepository` |
| `candles` | MarketDataModule | `market-data/entity/` | `CandleRepository` |
| `tick_aggregates` | MarketDataModule | `market-data/entity/` | `TickAggregateRepository` |
| `open_interest` | MarketDataModule | `market-data/entity/` | `OpenInterestRepository` |
| `funding_rates` | MarketDataModule | `market-data/entity/` | `FundingRateRepository` |
| `book_snapshots` | MarketDataModule | `market-data/entity/` | `BookSnapshotRepository` |
| `universe_membership` | MarketDataModule | `market-data/entity/` | `UniverseMembershipRepository` |
| `strategy_versions` | StrategyModule (future) | `strategy/entity/` **(M2 creates the module shell)** | `StrategyVersionRepository` |
| `positions` | PositionModule (future) | `position/entity/` **(M2 creates the module shell)** | `PositionRepository` |
| `transactions` | PositionModule (future) | `position/entity/` | `TransactionRepository` |
| `decisions` | StrategyModule (future) | `strategy/entity/` | `DecisionRepository` |
| `risk_state` | RiskModule (future) | `risk/entity/` **(M2 creates the module shell)** | `RiskStateRepository` |
| `account_snapshots` | PositionModule (future) | `position/entity/` | `AccountSnapshotRepository` |

**Domain modules that do not exist yet (Strategy, Position, Risk):** M2 creates a minimal
module shell for each (`strategy/`, `position/`, `risk/`) containing only its `entity/`
folder (+ barrel), its repositories, and a `*Module.ts` that does `TypeOrmModule.forFeature([...])`
and exports the repositories. **No services, no controllers, no listeners** in those
shells in M2 — those land in M3–M6. The entities do **not** move later; the shell simply
grows. This keeps every table registered in its true domain module's `forFeature` from
day one and avoids a later disruptive migration of files between modules.

**Why market-data tables are *not* in a PersistenceModule:** they are written by
MarketData's own `@OnEvent` persistence listeners (§4) and queried by MarketData/Backtest;
co-locating entity + repository + listener in MarketDataModule keeps cohesion high and
matches the "each module owns its entities" rule and ADR 0001's MarketData boundary.

### 2. NUMERIC ↔ decimal.js column transformer

A single reusable TypeORM `ValueTransformer`, `decimalColumnTransformer`, lives at
`apps/engine/src/common/utils/decimalColumnTransformer.ts` (barrel-exported from
`common/utils/index.ts`). It is the **only** way NUMERIC columns map into code.

Contract (TypeORM `ValueTransformer` shape):

```
to(value)   // entity → driver (write): MoneyValue | null → string | null
from(value) // driver → entity (read):  string | null    → MoneyValue | null
```

- `to(null)` → `null`; `to(MoneyValue)` → `formatMoney(value)` (decimal string, never a
  JS number). A JS `number` passed in is a programmer error — `to` MUST reject it by
  throwing a domain `MoneyTransformerException` (mirrors `parseMoney`'s refusal of
  `number`), so float money cannot leak silently through the ORM. It accepts a numeric
  *string* too (drivers occasionally hand strings back round-trip).
- `from(null)` → `null`; `from(string)` → `parseMoney(value)` (returns `MoneyValue`).
  decimal.js parsing already throws a typed `MoneyParseException` on garbage.
- Every money/price NUMERIC column declares `transformer: decimalColumnTransformer` and
  the TS property type is `MoneyValue` (or `MoneyValue | null` when nullable). **Never**
  `number`. Reviewers flag any NUMERIC column whose TS type is `number` as must-fix.

**Precision/scale guidance by column kind** (explicit `precision`/`scale` always; these are
generous, lossless defaults — a column may tighten only with justification):

| Kind | Columns (examples) | precision, scale |
|---|---|---|
| Price | `entry_price`, `exit_price`, `open/high/low/close`, `tick_size`, `vwap_at_entry`, `atr_at_entry`, `bollinger_*` | `(38, 18)` |
| Quantity / base volume | `qty`, `step_size`, `volume`, `volume_24h`, `tick_aggregates.volume` | `(38, 18)` |
| Notional / USDT | `entry_notional`, `min_notional`, `realized_pnl`, `fee`, `book_depth_*`, `open_exposure`, `balance`, `equity`, `unrealized_pnl`, `open_interest*` | `(38, 8)` |
| Pct / ratio | `*_pct` columns, `vwap_deviation_at_entry`, `oi_change_5m_at_entry`, `slippage_model_pct` | `(18, 8)` |
| Funding rate | `funding_rates.rate`, `funding_annualized_at_entry` | `(18, 10)` |
| Score | `idiosyncrasy_at_entry` (0–1), `signal_score_at_entry` (0–100) | `(10, 6)` |

`leverage` is small-integer-like but kept NUMERIC `(10, 4)` to allow fractional leverage.
`time_to_reversion_secs` is `integer` (not money). `coin_tier` see §5.

### 3. tick_aggregates — native declarative range partitioning by day, 90-day retention

~20–26M rows/day for 300 symbols at 1s makes a single heap table unmanageable for
inserts, vacuum, and retention. Decision: **native Postgres declarative range partitioning
on `ts`, daily granularity.**

- Parent table `tick_aggregates` is `PARTITION BY RANGE (ts)`. The PK and the
  `UNIQUE(symbol, ts)` constraint **must include the partition key `ts`** (Postgres
  requirement) → composite PK `(id, ts)` or, simpler and what we adopt, the entity keeps
  its `tick_aggregates_id` serial PK but the **uniqueness contract** is enforced as
  `UNIQUE(symbol, ts)` *per the partitioning rule must be `(symbol, ts)` and ts is the
  range key — so it is declared on the parent including ts*. Concretely: `PRIMARY KEY
  (tick_aggregates_id, ts)` and `UNIQUE (symbol, ts)`. The serial stays for `BaseRepository`
  compatibility (`id` is exposed as `tick_aggregates_id` aliased to the `id` property).
- **Partition creation:** a `@nestjs/schedule` cron in MarketDataModule
  (`TickAggregatePartitionService`) that runs daily and **pre-creates tomorrow's and the
  next few days' partitions** via raw SQL (`CREATE TABLE IF NOT EXISTS ... PARTITION OF
  tick_aggregates FOR VALUES FROM (...) TO (...)`). The migration creates the parent table
  plus an initial window of partitions (today .. today+7) so inserts never hit a missing
  partition on first boot. No pg_partman dependency — the cron + raw SQL is enough and
  keeps infra simple. The cron must be **idempotent** (`IF NOT EXISTS`) and log a warning,
  never crash, if a partition already exists. A missing-partition insert failure is a
  named risk (§6) the cron's look-ahead window mitigates.
- **Retention:** keep a **90-day rolling window** of `tick_aggregates`. A second daily
  cron `DROP TABLE`s partitions older than the window. 90 days comfortably covers the M7
  backtest's intraday-fidelity range while bounding storage (~90 × 25M rows). Older
  sub-minute data is **dropped, not downsampled** — the 1m/5m candle tables already retain
  the long-range OHLCV history, so dropping raw ticks loses no metric the backtest needs
  beyond the 90-day intraday window. The retention window is a `const/` value
  (`TICK_AGGREGATE_RETENTION_DAYS`), not inline.
- This is implementable with TypeORM raw-SQL migrations + a service issuing
  `queryRunner`/`DataSource.query` DDL. The entity maps the parent table normally; inserts
  route automatically to the correct partition.

### 4. Event → persistence wiring + NEW emit points M1 must add

M2 makes persistence a **passive `@OnEvent` subscriber inside MarketDataModule**
(`MarketDataPersistenceListener`, or one focused listener per stream). Listeners upsert via
repositories, idempotent on the UNIQUE constraints; duplicate-key is caught, logged at
`warn`, and swallowed (idempotency). Strategy/risk are not involved.

M1 today emits only `price.update`, `volatility.detected`,
`universe.symbolEntered`/`symbolLeft`. M2 needs to persist closed 1m+5m candles,
tick aggregates, OI samples, funding rates, instrument metadata, and tier changes.
**NEW event constants** (add to `common/const/eventConsts.ts`, UPPER_SNAKE_CASE) and their
payload interfaces (engine-internal, `market-data/interface/`, money fields as `MoneyValue`):

| New event constant | Value | Payload | Persisted to |
|---|---|---|---|
| `CANDLE_CLOSED_EVENT` | `marketData.candle.closed` | `ICandleClosedEvent { symbol; interval: '1m' \| '5m'; candle: ICandle }` | `candles` (UNIQUE `symbol, interval, open_time`) |
| `TICK_AGGREGATE_EVENT` | `marketData.tick.aggregate` | `ITickAggregateEvent { symbol; tsMs; price: MoneyValue; volume: MoneyValue }` | `tick_aggregates` (UNIQUE `symbol, ts`) |
| `OPEN_INTEREST_SAMPLED_EVENT` | `marketData.openInterest.sampled` | `IOpenInterestSampledEvent { symbol; tsMs; value: MoneyValue }` | `open_interest` (UNIQUE `symbol, ts`) |
| `FUNDING_RATE_OBSERVED_EVENT` | `marketData.fundingRate.observed` | `IFundingRateObservedEvent { symbol; fundingTimeMs; rate: MoneyValue }` | `funding_rates` (UNIQUE `symbol, funding_time`) |
| `INSTRUMENT_REFRESHED_EVENT` | `marketData.instrument.refreshed` | `IInstrumentRefreshedEvent { symbol; base; quote; status; tickSize; stepSize; minNotional; isTradable; volume24h; coinTier }` | `instruments` (UPSERT on UNIQUE `symbol`) |
| `UNIVERSE_SYMBOL_TIER_CHANGED_EVENT` | `marketData.universe.tierChanged` | `IUniverseTransition` (reuse; carries `tier`) | `universe_membership` (close prior row, open new) |

**`universe_membership` point-in-time semantics:** on `symbolEntered` insert a row
`(symbol, tier, entered_at, left_at=null)`; on `symbolLeft` set `left_at = now` on the open
row; on **tier change** close the open row (`left_at = now`) and open a fresh one with the
new tier and a new `entered_at`. This yields a gap-free timeline of which tier a symbol held
at any instant — required for survivorship-free backtest replay. `UniverseService` must be
extended to detect a tier change in `applyRanked` (compare `existing.tier` to the new tier)
and emit `UNIVERSE_SYMBOL_TIER_CHANGED_EVENT`. **Open-row contract:** `openMembership(symbol, …)` is idempotent. A concurrent caller observing the same symbol with `left_at IS NULL` MUST receive a successful no-op, not a unique-violation error. The DB-level partial unique index `uq_universe_membership_open_symbol` is the source of truth; repository callers are NOT required to hold an external lock. **`book_snapshots`** is written only around
decisions/open positions (per ADR 0001 / the M1 compromise); in M2 it is reached by the
same listener pattern when a `volatility.detected` carries depth — the row is keyed
`(symbol, ts)` and lined up with the triggering decision in M3.

`decisions`/`positions`/`transactions` get **no listener** in M2 — schema + repositories +
the `market_snapshot` Zod hook only. The Zod validation is a write-time guard the
`DecisionRepository.save` path calls (M3 wires the real writer); a missing field logs a
`warn`, never throws (per the brief).

### 5. Shared package — Zod market_snapshot schema + enums; engine consumes verbatim

The `market_snapshot` Zod schema is consumed at decision-write time (engine, M3) **and** by
the M7 backtest / M8 comparison, so it must be a single cross-workspace source of truth →
it lives in **`packages/shared`** alongside the M1 contract. **Zod becomes a `packages/shared`
dependency** (it is not yet present — flag to main session; the shared-maintainer adds it).

Shared layout additions: `packages/shared/src/enum/*` (new enums below) and
`packages/shared/src/schema/marketSnapshotSchema.ts` (Zod schema + inferred
`IMarketSnapshot` type), barrel-exported from `src/index.ts`.

**New shared enums** (PascalCase + `Enum` suffix, snake_case string values, consistent with
M1's resolved decision):

```ts
// PositionSideEnum.ts
export enum PositionSideEnum { SHORT = 'short', LONG = 'long' }
// PositionStatusEnum.ts
export enum PositionStatusEnum { OPEN = 'open', CLOSED = 'closed' }
// ExitReasonEnum.ts
export enum ExitReasonEnum {
    TAKE_PROFIT = 'take_profit', STOP_LOSS = 'stop_loss', TIME_STOP = 'time_stop',
    SIGNAL = 'signal', MANUAL = 'manual', KILL_SWITCH = 'kill_switch',
}
// PositionSlotEnum.ts
export enum PositionSlotEnum { A = 'A', B = 'B', C = 'C' }
// TransactionTypeEnum.ts
export enum TransactionTypeEnum {
    OPEN = 'open', ADD = 'add', REDUCE = 'reduce', CLOSE = 'close', FUNDING = 'funding',
}
// StrategyDirectionEnum.ts
export enum StrategyDirectionEnum {
    MEAN_REVERSION = 'mean_reversion', MOMENTUM = 'momentum', HYBRID = 'hybrid',
}
// StrategyStatusEnum.ts
export enum StrategyStatusEnum { DRAFT = 'draft', ACTIVE = 'active', ARCHIVED = 'archived' }
```

M1's `CoinTierEnum`, `RegimeLabelEnum`, `VwapAnchorTypeEnum`, `FlowTypeEnum`,
`DeviationSideEnum` are **reused** (no duplication).

**`coin_tier` storage reconciliation:** the brief writes `positions.coin_tier SMALLINT`,
but `CoinTierEnum` values are strings (`'tier1'`..). Decision: **store the enum string
value, not a smallint**, in a `coin_tier varchar` column across `positions` and
`instruments`, mapped to `CoinTierEnum`. Rationale: a single canonical representation (the
shared enum) avoids a fragile int↔string mapping table and keeps DB rows self-describing for
SQL analysis; the smallint micro-optimisation is not worth the divergence risk. This
**overrides the brief's `SMALLINT`** for `coin_tier` — surfaced to the main session. All
other enum columns likewise store the snake_case string value (varchar), not an int.

**`market_snapshot` field list (Zod schema — implement verbatim).** Money/price fields are
validated as decimal **strings** (`z.string().regex(decimalRegex)`) because the snapshot is
JSONB and crosses the wire; scores/ratios/pcts/counts are `z.number()`; enums are
`z.nativeEnum(...)`. Required fields (missing → logged warning, not a throw — the schema is
`.safeParse`d at write):

```
vwap_session: string(decimal)        vwap_20bar: string(decimal)
vwap_deviation_pct: number           vwap_deviation_sigma: number
volume_ratio: number                 volume_20bar_avg: string(decimal)
atr_14: string(decimal)              adx_14: number
adx_di_plus: number                  adx_di_minus: number
rsi_14: number                       bollinger_upper: string(decimal)
bollinger_lower: string(decimal)     bollinger_pct_b: number
btc_5m_move_pct: number              idiosyncrasy_score: number
funding_rate: number                 funding_rate_annualized: number
bid_ask_spread_pct: number           estimated_slippage_pct: number
coin_tier: CoinTierEnum              coin_volume_rank: number
correlation_mode: string             signal_score: number
position_slot: PositionSlotEnum      active_positions_count: number
regime_label: RegimeLabelEnum        entry_candle_open_time: number
open_interest: string(decimal)       open_interest_change_5m_pct: number
open_interest_change_15m_pct: number agg_trade_buy_volume_ratio: number
market_breadth_5m_up_pct: number     same_bar_trigger_count: number
book_depth_10bps_usdt: string(decimal)  book_depth_50bps_usdt: string(decimal)
vwap_anchor_type: VwapAnchorTypeEnum    symbol_universe_age_hours: number
btc_1m_move_pct: number              eth_5m_move_pct: number
flow_type: FlowTypeEnum
```

This list **must stay aligned** with `IVolatilityDetectedEvent` (ADR 0001) — every snapshot
field has a source field on that payload. Schema drift between the two is a named risk (§6).

### 6. Build order & risks

**Build order (per dispatch waves):**

1. **`bot-shared-maintainer` (serial).** Add `zod`; implement the seven new enums and
   `marketSnapshotSchema` + `IMarketSnapshot`, barreled from `src/index.ts`. Nothing
   downstream typechecks without this.
2. **`bot-engine-nestjs`.** In order: `decimalColumnTransformer` (common) → entities in
   their owning modules' `entity/` folders → the schema migration(s) (full schema +
   tick_aggregates parent + initial partitions) → repositories (one per entity, extending
   `BaseRepository`, no barrel) → the `strategy_versions` v0–v3 seed (a dedicated seed
   migration or idempotent seeder) → the new event constants/payloads → MarketData
   `@OnEvent` persistence listeners + the partition/retention crons → extend
   `UniverseService` to emit tier-change. QA last (repository methods unit-tested against a
   test DB).

**Risks to defend in review:**

- **Float money leaking via the transformer.** `to()` must reject a JS `number` and only
  ever hand the driver a string; reviewers verify every NUMERIC column's TS type is
  `MoneyValue`, not `number`.
- **Look-ahead / survivorship bias.** `universe_membership` and `funding_rates` must be
  strictly point-in-time (gap-free tier timeline; actual historical funding, not a
  constant). A backtest that reads "current" membership is a must-fix.
- **Partition-creation gaps.** If the cron's look-ahead window lapses (downtime), an insert
  hits a missing partition and fails. Mitigation: pre-create several days ahead; the
  listener catches the failure, logs `error`, and the cron self-heals on next run — but a
  silent data gap is the real danger and must be alarmed in M9.
- **`market_snapshot` schema drift** from the `IVolatilityDetectedEvent` payload. A field
  renamed on one side and not the other passes `safeParse` as a missing field (only a
  warning) and silently degrades the dataset. A shared test should assert every snapshot
  key has a source on the volatility payload.
- **Migration `down()` not a true inverse.** Partitioned tables, seeds, and FKs make
  `down()` easy to get wrong. Each `down()` must drop in exact reverse order (child partitions
  → indexes → FKs → tables; delete seeded rows by stable key) and be exercised by
  `migration:revert` in QA.

## Alternatives considered

- **Central PersistenceModule owning all 13 entities + repositories.** Rejected: violates
  the authoritative "each module owns its entities / `forFeature`" rule, lowers cohesion
  (MarketData would not own the tables it writes), and the entities glob makes central
  ownership give zero benefit. The overview line is re-read as infra ownership instead.
- **Defer Strategy/Position/Risk entities into a temporary holding module until M3+.**
  Rejected: the entities would later have to migrate files between modules (churn + import
  rewrites). Creating thin module shells now places each table in its true module from day
  one at near-zero cost.
- **tick_aggregates as a single heap table with a `DELETE … WHERE ts < cutoff` retention
  job.** Rejected: bulk `DELETE` on 25M rows/day bloats and vacuums poorly; `DROP TABLE` of
  a daily partition is instant and reclaims space immediately.
- **pg_partman for partition management.** Rejected for M2: adds a Postgres extension
  dependency and ops surface for what a small idempotent cron + raw SQL handles; revisit
  only if partition logic grows.
- **Downsample old ticks into a coarser aggregate instead of dropping.** Rejected: the 1m/5m
  candle tables already retain long-range OHLCV; a third intermediate resolution adds schema
  and write load without a consumer inside the 90-day backtest window.
- **`coin_tier` as SMALLINT (per the brief) with an int↔enum map.** Rejected: introduces a
  second representation of tier that can drift from `CoinTierEnum`; storing the enum string
  keeps one canonical value and self-describing rows. Surfaced as an intentional override.
- **Store NUMERIC columns as JS `number` via TypeORM's default behaviour.** Rejected
  outright — violates the money-as-decimal trading-safety invariant; the transformer exists
  precisely to forbid it.
- **Per-domain migration folders.** Rejected: one schema has one history; a single ordered
  `src/database/migrations/` timeline is simpler to reason about and reverts cleanly.

## M27 Amendment (2026-06-08) — additive capture columns (see ADR 0043)

**Milestone:** M27 (decision data-capture completeness). **Status:** Accepted.

M27 extends two tables this ADR created, **additive/nullable only** (no `NOT NULL` backfill,
no drop, no type change; `down` drops only the new columns/indexes). Full rationale and the
observability-only invariant are in ADR 0043.

- **`decisions`** gains top-level trade-geometry columns mirroring `shadow_decisions`:
  `gate_allowed` (boolean), `trade_side`, `stop_loss`, `take_profit`, `qty`, `notional`,
  `leverage` (money/price via `decimalColumnTransformer`, §2), plus `halt_reason_detail`
  (gate-owned leg string, read verbatim — not date-joined, not re-derived). **Trade geometry is
  NOT added to `marketSnapshotSchema`** (§5) — that strict 40-field market-*context* contract is
  unchanged. The only `market_snapshot` change is the runtime value of `active_positions_count`
  (the hard-coded dry-run `0` is replaced by the real post-evaluate open count; the field/schema
  itself is unchanged).
- **`book_snapshots`** (non-partitioned, §1) gains a nullable `event_id` column, a **nullable
  UNIQUE index on `event_id`** (idempotency — one book row per trigger), and an optional
  `mid_at_trigger` numeric column. A best-effort writer (mirrors the §4 swallow pattern; never on
  the order path) persists trigger-time **spread/depth aggregates** keyed by `event_id`, exactly
  rejoinable to the decision row. **Raw L2 is out of scope** (aggregates only). **Retention is
  deferred** to a separate follow-up ADR with its own DB-safety plan — M27 adds the column +
  writer only; no partition conversion, no retention job.

Decision-row Zod validation (§4) becomes hard-fail in `NODE_ENV=test`/local-dev only and stays
warn-only in paper/testnet/live (a prod throw would block a gate-approved open — `gateAndPersist`
persists before emitting). `SchemaValidationService` (ADR 0025) is updated for the new
`book_snapshots` required columns.

## See also

- `docs/plans/M2-persistence.md`, `docs/plans/00-overview.md` ("Data model" section)
- `docs/architecture/adr/0043-m27-decision-data-capture-completeness.md` (M27 additive capture columns)
- `docs/architecture/adr/0001-exchange-and-market-data.md` (the `IVolatilityDetectedEvent`
  payload the `market_snapshot` schema mirrors; the MarketData boundary)
- `docs/best-practices/code-conventions.md` (Entity/Repository/Migration/Constants rules)
- Contract specification + build-order note: sections below.

---

# Contract specification (for `bot-shared-maintainer` + `bot-engine-nestjs`, implement verbatim)

## Shared (`packages/shared`) — `bot-shared-maintainer`, first/serial

1. Add `zod` as a dependency of `packages/shared`.
2. Add the seven enums in §5 (`PositionSideEnum`, `PositionStatusEnum`, `ExitReasonEnum`,
   `PositionSlotEnum`, `TransactionTypeEnum`, `StrategyDirectionEnum`, `StrategyStatusEnum`)
   under `src/enum/`, each barrel-exported. Reuse M1's `CoinTierEnum`, `RegimeLabelEnum`,
   `VwapAnchorTypeEnum`, `FlowTypeEnum`, `DeviationSideEnum`.
3. Add `src/schema/marketSnapshotSchema.ts`: a Zod object with exactly the fields/types in
   §5, money/price fields as decimal-`string`, enums via `z.nativeEnum`. Export the schema
   and `export type IMarketSnapshot = z.infer<typeof marketSnapshotSchema>`. Barrel from
   `src/index.ts`.

## Engine (`apps/engine`) — `bot-engine-nestjs`

- `common/utils/decimalColumnTransformer.ts` — the `ValueTransformer` per §2 contract;
  barrel from `common/utils/index.ts`. Add `MoneyTransformerException` to `common/exception`.
- Entities + repositories in their owning modules per the §1 table. Every entity:
  `@Entity({ name: '<snake_case>', synchronize: false })`, `@PrimaryGeneratedColumn({ name:
  '<table>_id' })` exposed as the `id` property, snake_case `name:` on every column, explicit
  `type`, money columns `type: 'numeric'` + precision/scale (§2) + `transformer:
  decimalColumnTransformer`, nullable as `{ nullable: true }` + `?: T | null`, timestamps
  `timestamptz`. FKs per Entity Relations (`@ManyToOne` + `@JoinColumn` + co-located FK
  `@Column`), `onDelete` RESTRICT/SET NULL/CASCADE per conventions, `onUpdate` CASCADE.
- Module shells `strategy/`, `position/`, `risk/` (entity + barrel + repositories +
  `*Module.ts` with `forFeature` + repository providers/exports). No services/listeners yet.
- Migrations in `src/database/migrations/`, `YYYYMMDDHHMMSS-Name.ts`, transaction mode
  `each`, reversible `down()` in exact reverse order. tick_aggregates parent + initial
  partition window in its migration; FKs and indexes per the overview data-model
  (`idx(symbol, interval, open_time)` etc., the `UNIQUE`s listed, `decisions.event_id` index,
  `positions` `idx(strategy_version_id, status)` + `idx(symbol, status)`).
- `strategy_versions` v0–v3 seed (idempotent on `name+version`) with the shared base params
  + per-version additions from the brief, `direction` via `StrategyDirectionEnum`, `status`
  via `StrategyStatusEnum`.
- New event constants in `common/const/eventConsts.ts` + payload interfaces in
  `market-data/interface/` (§4). MarketData `@OnEvent` persistence listener(s) + the
  `TickAggregatePartitionService` (create-ahead + retention crons). Extend `UniverseService`
  to emit `UNIVERSE_SYMBOL_TIER_CHANGED_EVENT` on tier change.
- `decisions`/`positions`/`transactions`: schema + repositories only; `DecisionRepository`
  exposes the `market_snapshot` Zod-`safeParse` write-time hook (warn on missing field).

## Build-order summary

shared (zod + enums + schema) → engine: transformer → entities → schema migration(s)
(+ partitions) → repositories → v0–v3 seed → events/listeners/crons + universe tier-change →
QA (repository unit tests against a test DB; `migration:run`/`migration:revert` round-trip).
