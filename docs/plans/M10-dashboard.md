# M10 — Dashboard (React, containerized)

**Goal:** A real-time, read-only dashboard to watch positions and performance, with
a single kill-switch button.

**Depends on:** M9 (read API + WS + halt endpoint).

## Tasks

- **React app** (Vite + TypeScript + shadcn/ui) consuming the M9 read API.
  - *Output:* app builds and authenticates against the engine API.
- **Live positions table** via WS/SSE: symbol, side, leverage, entry/current price, unrealized PnL, age.
  - *Output:* positions tick in real time.
- **Decisions feed.** Recent decisions with reason (acted/skipped).
  - *Output:* live decision log.
- **Performance-by-version view.** Win rate, PnL, drawdown per strategy version.
  - *Output:* comparison table/chart.
- **Kill-switch button** wired to the halt endpoint, with confirm step + auth.
  - *Output:* button halts trading; state reflected in UI.
- **Containerize.** Build the static bundle and serve it via an **nginx container** wired into `docker compose`. Reaches the engine API over the internal network in dev, and the authenticated engine endpoint in prod. Deployment topology in `M11-go-live-hardening.md`.
  - *Output:* dashboard container serving the live UI.

## Definition of done

The dashboard container shows real testnet positions updating in real time, a live
decision feed, per-version performance, and a working authenticated halt button.
