# M4 — Risk management

**Goal:** A central gatekeeper that no signal can bypass, enforcing capital and
exposure discipline.

**Depends on:** M3 (signals).

## Tasks

- **Position sizing.** Size as a % of allocated capital at minimum leverage.
  - *Output:* signal → concrete order quantity respecting instrument step/min-notional.
- **Daily & weekly loss limits.** Track realized PnL in `risk_state`; halt new entries when a limit is hit.
  - *Output:* breaching the limit blocks further entries; logged.
- **Daily AND weekly windows defined.** State the exact boundary (UTC day; rolling-7d or ISO-week) and the source of realized PnL for each. `risk_state` is daily-keyed; the weekly figure is the defined aggregation over days.
  - *Output:* documented window definitions; weekly limit computed from them.
- **Exposure caps with in-flight reservation.** Max concurrent positions and max exposure per coin, evaluated against *confirmed + submitted-but-unfilled* intents. Reserve exposure at approval time; release on reject/fill-fail, **and on a TTL expiry reconciled by M6** when an order's outcome is permanently unknown (so reservations can't leak). The per-coin cap is **liquidity-scaled** (e.g. a fraction of rolling volume / book depth), not one flat USDT constant across 300 heterogeneous coins.
  - *Output:* concurrent signals cannot collectively exceed the caps; a thin-book altcoin gets a smaller cap than BTC; no reservation leaks.
- **Liquidity & funding filters.** Skip coins below a volume floor; account for perpetual funding direction/cost.
  - *Output:* illiquid/unfavorable-funding signals rejected with reason.
- **Stop-loss & trailing-take-profit rules.** Compute protective levels per position at entry. **The stop must sit inside the liquidation distance** (sizing accounts for worst-case adverse move + funding drag). Optional **max-hold time-stop** so a never-reverting mean-reversion trade can't sit indefinitely accruing funding.
  - *Output:* every approved order carries SL/TP (and optional time-stop) params; SL proven to trigger before liquidation.
- **Cooldown.** After a loss on a symbol, suppress re-entry for a window.
  - *Output:* no immediate re-entry on the same symbol post-loss.
- **Risk gate covers ALL order actions.** The gate vets `open / add / reduce / close` — not just entries. Exits and kill-switch flatten are always *allowed* but still routed through the gate (so nothing reaches the exchange order API outside it). Rejections written as `decisions` with reason.
  - *Output:* unit tests proving (a) over-limit/over-exposure entries are blocked and (b) reduce/close/flatten still pass through the gate, never around it.

## Definition of done

A unit-tested risk gate that vets all four order actions, reserves in-flight
exposure, enforces daily/weekly windows and SL-inside-liquidation, and converts
signals into approved intents or logged rejections. Nothing reaches execution
without passing it.
