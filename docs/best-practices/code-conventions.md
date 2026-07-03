---
description: Code style, naming conventions, entity/DTO/repository patterns, control-flow rules, and testing guidelines for the trade-bot project. AUTHORITATIVE — overrides generic Clean Code defaults where they conflict.
globs: "apps/engine/src/**/*.ts"
alwaysApply: false
---

# Conventions

> These are the team's strict rule set. Where they conflict with `~/.claude/rules/clean-code.md`, **these win**. `bot-review-clean-code` applies this file first.

## Formatting (Prettier)

- **Indent:** 4 spaces for `.ts`, `.js`, `.tsx`, `.json`
- **Quotes:** single quotes for TS/JS/JSON
- **Print width:** 160 characters
- **Trailing commas:** always (`trailingComma: 'all'`)
- **Semicolons:** always
- **Arrow parens:** always (`(x) => ...`)

## TypeScript Config

- **Target:** ES2023, module: `nodenext`
- **Strict modes:** `strictNullChecks`, `noImplicitAny`, `strictBindCallApply`
- **Decorators:** `experimentalDecorators` + `emitDecoratorMetadata` (required for NestJS DI)

## ESLint Rules

- `@typescript-eslint/no-explicit-any`: **off**
- `@typescript-eslint/no-floating-promises`: **warn** (enabled type-aware in the engine app config)
- `prettier/prettier`: **error**
- `no-console`: **warn** (allow `warn`/`error`)

## Money is decimal — never float

- Prices, quantities, PnL, fees, and notional values use PostgreSQL `numeric` columns and `decimal.js` in code.
- **Forbidden:** JS `number` arithmetic on any monetary value. Float rounding corrupts accounting.
- Across the wire (shared view types), serialize decimals as `string`.
- `bot-review-clean-code` and `bot-review-logic` MUST flag float money math as must-fix.

## Naming Conventions

| Kind | Convention | Example |
|---|---|---|
| Files — classes | PascalCase | `RiskService.ts` |
| Files — interfaces | `I` prefix + PascalCase | `IStrategy.ts` |
| Files — enums | PascalCase + `Enum` suffix | `PositionSideEnum.ts` |
| Files — constants | camelCase | `riskConsts.ts` |
| Files — utils | camelCase | `computeRollingChange.ts` |
| Classes | PascalCase | `MeanReversionStrategy` |
| Interfaces | `I` prefix | `IStrategy`, `IMarketSnapshot` |
| Enum declarations | PascalCase + `Enum` suffix | `ExitReasonEnum` |
| Constants | UPPER_SNAKE_CASE | `MAX_OPEN_POSITIONS` |
| Entity properties | camelCase | `entryPrice` |
| DB columns | snake_case | `entry_price` |

## Entity Rules

- `@Entity({ name: 'snake_case_table', synchronize: false })` — schema is migration-driven.
- PK: `@PrimaryGeneratedColumn({ name: '<table>_id' })` → auto-increment integer (use `uuid` only when justified).
- Column names snake_case in DB, camelCase in TS; always specify `name:`.
- Always specify `type` in `@Column` (`'varchar'`, `'text'`, `'integer'`, `'bigint'`, `'numeric'`, `'timestamptz'`, `'boolean'`, `'jsonb'`).
- Money columns: `type: 'numeric'` with explicit `precision`/`scale`; map to `decimal.js` via a transformer, never to `number`.
- Nullable: `{ nullable: true }` + TS `?: T | null`.
- Timestamps: `created_at`/`updated_at` with `default: () => 'CURRENT_TIMESTAMP'`; use `timestamptz`.

### Entity Relations

- `@ManyToOne(() => RelatedEntity)` + `@JoinColumn({ name: 'fk_column', referencedColumnName: 'pkProperty' })`.
- Define BOTH the FK `@Column` and the `@ManyToOne` relation on the same DB column.
- `referencedColumnName` uses the TS property name.

### Entity Barrel

Every entity is re-exported from its module's `entity/index.ts` and registered in the owning module's `TypeOrmModule.forFeature([...])`. Each module owns its own entities.

## DTO/Interface Naming

- Request DTOs: `<Action>RequestDto` (e.g., `ListPositionsRequestDto`).
- Response interfaces: `I<Entity>Response` or `I<Entity>View`.

## Repository Pattern

- One repository per entity; extends `BaseRepository<T>` (abstract, `apps/engine/src/common/repository/BaseRepository.ts`).
- Injected via `@InjectRepository(Entity)` + passed to `super(repository)`.
- Domain-specific queries as intention-revealing public methods (`findOpenBySymbol`, `findClosedSince`), never `find({ where: ... })` in services.
- No repository barrel — import each repo by direct path.

## Service Layer

- `*Service` — business logic; calls repositories and the exchange client.
- `*Gateway` — WebSocket handlers; emit events to clients. Keep gateway logic light; state updates happen in services.
- Use NestJS `Logger` (not `console.log`): `private readonly logger = new Logger(MyService.name)`.
- `Promise.all` for parallel independent I/O.
- `private readonly` for all injected dependencies.

## Trading-domain rules

- **Strategies are pure and deterministic.** No `Date.now()`, no `Math.random()`, no I/O. All inputs arrive as market state. This guarantees backtests reproduce live behavior.
- **The risk gate is mandatory.** Signals become orders only by passing `RiskModule`. Never call the exchange order API from a strategy or controller.
- **Idempotent execution.** Client order IDs / unique constraints prevent double-fire on retry/restart.
- **Exchange is the source of truth.** Reconcile local state against it; never assume a fill without confirmation.
- **No LLM in the live trade loop.** LLM/agentic work is outer-loop only.

## Control flow & spacing

- Every loop/conditional body MUST use braces, even single statements. Forbidden: `if (x) doThing();`. Required: `if (x) { doThing(); }`.
- A blank line MUST appear before AND after every `if`, `for`, `while`, `switch` block (exception: when adjacent to the enclosing block edge).
- A blank line MUST appear before every `return` (exception: when `return` is the only statement in its block).
- **Reviewers MUST flag any violation as must-fix.**

```typescript
async closeIfProfitTarget(position: Position, price: Decimal): Promise<void> {

    if (!position.isOpen()) {
        return;
    }

    const pnl = this.computeUnrealizedPnl(position, price);

    if (pnl.gte(position.takeProfitTarget)) {
        await this.executionService.close(position, ExitReasonEnum.TAKE_PROFIT);
    }
}
```

## Type assertions

- Prefer `satisfies` over `as`. Use `as` only when the runtime type is genuinely narrower (e.g., `JSON.parse` results, narrowing from `unknown`).
- Forbidden: `as unknown as X` double-casts.

## Barrel Exports

Each subfolder (`entity/`, `interface/`, `const/`, `enum/`, `utils/`, `controller/`, `service/`, `gateway/`) has an `index.ts` re-exporting public members. **Exceptions:** `repository/` and `dto/` have no barrel.

## Constants Placement

**AUTHORITATIVE:** Every constant (numeric/string literal, regex, default config, threshold, interval, limit) not strictly local to one function MUST live in a `const/` folder of its module.

- **Path:** `apps/engine/src/<domain>/const/<Domain>Consts.ts`
- **Export names:** `UPPER_SNAKE_CASE`
- **Barrel:** `const/index.ts`
- **Forbidden:** top-of-file exported `const`s alongside services/entities; inline magic numbers/strings (e.g. `0.025` for the 2.5% threshold, `60_000` for a window).

```typescript
// riskConsts.ts
export const MAX_OPEN_POSITIONS = 10;
export const MAX_EXPOSURE_PER_COIN_USDT = 100;
export const DAILY_LOSS_LIMIT_USDT = 50;
export const COOLDOWN_AFTER_LOSS_MS = 15 * 60 * 1000;
export const VOLATILITY_THRESHOLD_PCT = 2.5;
```

## Error Handling

- **Integration calls (exchange/external APIs):** `try/catch` → log with context → rethrow as a domain exception.
- **Domain services:** let errors propagate.
- **Duplicate key on insert:** catch, inspect for `'duplicate key'`/`'unique constraint'`, log warn and return (idempotency).
- **Global filter:** `AllExceptionsFilter` produces the canonical JSON shape (`{ code, message, requestId, details }`).

## Migration Rules

- **File naming:** `YYYYMMDDHHMMSS-<DescriptiveName>.ts`.
- **Reversible:** `down()` reverses in exact opposite order (drop indexes → drop FKs → drop table).
- **onDelete:** RESTRICT for required lookups, SET NULL for optional FKs, CASCADE for dependent children. **onUpdate:** CASCADE.
- **Transaction mode:** `each`.

## Environment Variables

- **Every new env var/flag ships with its `.env.example` entry in the same commit** — not a follow-up. This applies to any new `EnvironmentVariables.ts` field or `AppConfigService` flag.
- Match the existing block style: what it does, exact gating conditions (e.g. "effective only when `EXCHANGE_ENV=paper`"), default value, and an explicit "NEVER set in live/testnet" where applicable.
- Paper-only exploration flags belong in the "Paper exploration profile" block pattern (see `PAPER_RELAX_*` entries), commented out with the recommended value shown so a live operator can't copy the block and silently loosen live risk.

## Build & lint gate

**AUTHORITATIVE:** Every implementer enforces zero-defect build + lint before handing off to review.

- Required pre-handoff: `pnpm --filter <workspace> build` AND `pnpm --filter <workspace> lint` (and `tsc --noEmit` where it differs) both pass.
- Zero TS errors, zero lint errors. Warnings fixed unless documented with a one-line justification.
- **No suppressions as a fix:** `eslint-disable`, `@ts-ignore`, `as any` forbidden as workarounds — allowed only at genuine boundaries with an explanatory comment.

## Milestone Review Loop

**AUTHORITATIVE: two mandatory review rounds per milestone.**

1. After implementation + QA, the main session dispatches `bot-review-security`, `bot-review-logic`, `bot-review-clean-code`, `bot-review-quant` in parallel.
2. Every `blocker`/`high`: dispatch the relevant specialist to fix. `medium`: fix if cheap, else carry over. Document fixes in `docs/work-log.md`.
3. Round 2: re-run all three reviewers in parallel. Remaining blockers/highs must be fixed; mediums documented as carry-overs.
4. Milestone marked done when no blockers/highs remain. `bot-scribe` writes the "Outcome / Review rounds" section in `docs/plans/archive/MN-*.md` and updates the milestone pointer in `CLAUDE.md`.

## See also

- `docs/architecture/overview.md` — module structure
- `docs/architecture/adr/` — Architecture Decision Records
- `docs/plans/` — milestone briefs
