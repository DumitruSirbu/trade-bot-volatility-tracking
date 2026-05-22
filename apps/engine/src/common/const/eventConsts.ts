// Event names for the @nestjs/event-emitter bus. String literals for event
// names live here (never inline) so emitters and handlers cannot drift apart.
export const HEALTH_PING_EVENT = 'common.health.ping';

// Market-data events. Emitted by MarketDataModule on the @nestjs/event-emitter
// bus; consumed by strategy/risk/persistence in later milestones.
export const PRICE_UPDATE_EVENT = 'marketData.price.update';
export const VOLATILITY_DETECTED_EVENT = 'marketData.volatility.detected';

// Universe-membership transitions (M2 persists these to universe_membership).
export const UNIVERSE_SYMBOL_ENTERED_EVENT = 'marketData.universe.symbolEntered';
export const UNIVERSE_SYMBOL_LEFT_EVENT = 'marketData.universe.symbolLeft';

// M2 persistence events (ADR 0002 §4). Emitted by MarketData where the value is already
// computed; consumed by the passive MarketDataPersistenceListener which upserts via
// repositories (idempotent on each table's UNIQUE constraint).
export const CANDLE_CLOSED_EVENT = 'marketData.candle.closed';
export const TICK_AGGREGATE_EVENT = 'marketData.tick.aggregate';
export const OPEN_INTEREST_SAMPLED_EVENT = 'marketData.openInterest.sampled';
export const FUNDING_RATE_OBSERVED_EVENT = 'marketData.fundingRate.observed';
export const INSTRUMENT_REFRESHED_EVENT = 'marketData.instrument.refreshed';
export const UNIVERSE_SYMBOL_TIER_CHANGED_EVENT = 'marketData.universe.tierChanged';
