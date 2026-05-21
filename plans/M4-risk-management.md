# M4 — Risk management

**Goal:** A central gatekeeper that no signal can bypass, enforcing capital and
exposure discipline.

**Depends on:** M3 (signals).

## Tasks

- **Position sizing.** Size as a % of allocated capital at minimum leverage.
  - *Output:* signal → concrete order quantity respecting instrument step/min-notional.
- **Daily & weekly loss limits.** Track realized PnL in `risk_state`; halt new entries when a limit is hit.
  - *Output:* breaching the limit blocks further entries; logged.
- **Exposure caps.** Max concurrent positions and max exposure per coin.
  - *Output:* signals beyond caps are rejected.
- **Liquidity & funding filters.** Skip coins below a volume floor; account for perpetual funding direction/cost.
  - *Output:* illiquid/unfavorable-funding signals rejected with reason.
- **Stop-loss & trailing-take-profit rules.** Compute protective levels per position at entry.
  - *Output:* every approved order carries SL/TP parameters.
- **Cooldown.** After a loss on a symbol, suppress re-entry for a window.
  - *Output:* no immediate re-entry on the same symbol post-loss.
- **Risk gate.** Signal → approved order intent OR rejection; rejections written as `decisions` with reason.
  - *Output:* unit tests proving over-limit/over-exposure signals are blocked.

## Definition of done

A unit-tested risk gate that converts signals into approved order intents or
logged rejections, demonstrably enforcing every limit. Nothing reaches execution
without passing it.
