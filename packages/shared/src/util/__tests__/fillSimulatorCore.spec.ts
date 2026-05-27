import { describe, it, expect } from 'vitest';

import { CoinTierEnum, OrderPolicyEnum } from '../../enum/index';
import { IFillIntent } from '../../interface/IFillIntent';
import { IFillPosition } from '../../interface/IFillPosition';
import { IFillSeed } from '../../interface/IFillSeed';
import { IFillSnapshot } from '../../interface/IFillSnapshot';
import { applyFill, applyIntraBarStop } from '../fillSimulatorCore';
import { ITickAggregateSnapshot } from '../intraBarStopEvaluator';
import { ITickSnapshot } from '../missedFillDetector';

describe('FillSimulatorCore', () => {
	describe('applyFill', () => {
		it('should simulate a simple fill with tier-1 slippage', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'open',
				policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
				limitPrice: '100.05',
				qty: '1.0',
				postOnly: false,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_1,
				{ slippage_tier1_pct: 0.15 },
				seed,
				[],
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			expect(result.qty).toBe('1.0');
			expect(parseFloat(result.slippagePct)).toBeGreaterThan(0);
			expect(result.missedReason).toBeNull();
		});

		it('should apply correct fee rate for maker policy', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'short',
				action: 'open',
				policy: OrderPolicyEnum.POST_ONLY_MAKER,
				limitPrice: '100.05',
				qty: '1.0',
				postOnly: true,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_1,
				{},
				seed,
				[],
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			// Maker fee is 2 bps: 100.05 * 1.0 * 0.0002 = 0.02001
			const expectedFeeMin = 0.01;
			const expectedFeeMax = 0.05;
			const feeValue = parseFloat(result.feeUsdt);
			expect(feeValue).toBeGreaterThanOrEqual(expectedFeeMin);
			expect(feeValue).toBeLessThanOrEqual(expectedFeeMax);
		});

		it('should apply correct fee rate for taker policy', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'reduce',
				policy: OrderPolicyEnum.REDUCE_MARKET,
				limitPrice: '100.05',
				qty: '1.0',
				postOnly: false,
				reduceOnly: true,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_1,
				{},
				seed,
				[],
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			// Taker fee is 4 bps: 100.05 * 1.0 * 0.0004 = 0.04002
			const feeValue = parseFloat(result.feeUsdt);
			expect(feeValue).toBeGreaterThan(0.02);
		});

		it('should apply tier-2 slippage', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'open',
				policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
				limitPrice: '100.05',
				qty: '1.0',
				postOnly: false,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_2,
				{ slippage_tier2_pct: 0.5 },
				seed,
				[],
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			const slippagePct = parseFloat(result.slippagePct);
			expect(slippagePct).toBeGreaterThan(0.4);
			expect(slippagePct).toBeLessThan(0.6);
		});

		it('should apply tier-3 slippage', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'open',
				policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
				limitPrice: '100.05',
				qty: '1.0',
				postOnly: false,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_3,
				{ slippage_tier3_pct: 1.0 },
				seed,
				[],
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			const slippagePct = parseFloat(result.slippagePct);
			expect(slippagePct).toBeGreaterThan(0.9);
			expect(slippagePct).toBeLessThan(1.1);
		});

		it('should detect missed fill when limit not touched', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'open',
				policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
				limitPrice: '99.00', // LONG buy wants ask to come down to 99.00
				qty: '1.0',
				postOnly: false,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const ticks: ITickSnapshot[] = [
				{ high: '100.10', low: '100.00', ts: new Date(2000) },
				{ high: '100.15', low: '100.05', ts: new Date(3000) },
			];

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_1,
				{},
				seed,
				ticks,
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(false);
			expect(result.missedReason).toBe('timeout');
			expect(result.qty).toBe('0');
		});

		it('should detect filled when limit is touched', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '99.00',
				ts: 1000,
			};

			const intent: IFillIntent = {
				side: 'long',
				action: 'open',
				policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
				limitPrice: '100.05', // LONG buy wants ask to come down to 100.05
				qty: '1.0',
				postOnly: false,
				reduceOnly: false,
			};

			const seed: IFillSeed = {
				seedBytes: Buffer.from('test-seed'),
				version: 'v1',
			};

			const ticks: ITickSnapshot[] = [
				{ high: '100.10', low: '100.00', ts: new Date(2000) }, // low = 100.00 <= 100.05
				{ high: '100.15', low: '100.05', ts: new Date(3000) },
			];

			const result = applyFill(
				snapshot,
				intent,
				CoinTierEnum.TIER_1,
				{},
				seed,
				ticks,
				1000,
				5000,
				1000,
			);

			expect(result.filled).toBe(true);
			expect(result.qty).toBe('1.0');
		});
	});

	describe('applyIntraBarStop', () => {
		it('should detect stop loss hit on long position', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.00',
				low: '98.50', // bar touched below SL
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'long',
				size: '1.0',
				stopLoss: '99.00',
				takeProfit: '101.00',
				timeStopDeadlineMs: null,
			};

			const ticks: ITickAggregateSnapshot[] = [
				{ high: '100.50', low: '99.50', close: '100.00', ts: new Date(2000) },
				{ high: '100.00', low: '98.50', close: '98.75', ts: new Date(3000) }, // SL hit
				{ high: '100.50', low: '99.00', close: '100.00', ts: new Date(4000) },
			];

			const result = applyIntraBarStop(snapshot, position, ticks, 1000);

			expect(result).not.toBeNull();
			expect(result!.filled).toBe(true);
			expect(result!.hit).toBe('stop_loss');
		});

		it('should detect take profit hit on long position', () => {
			const snapshot: IFillSnapshot = {
				bid: '101.00',
				ask: '101.10',
				last: '101.05',
				mark: '101.05',
				high: '101.50', // bar touched above TP
				low: '100.00',
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'long',
				size: '1.0',
				stopLoss: '99.00',
				takeProfit: '101.00',
				timeStopDeadlineMs: null,
			};

			const ticks: ITickAggregateSnapshot[] = [
				{ high: '100.50', low: '99.50', close: '100.00', ts: new Date(2000) },
				{ high: '101.50', low: '100.50', close: '101.25', ts: new Date(3000) }, // TP hit
			];

			const result = applyIntraBarStop(snapshot, position, ticks, 1000);

			expect(result).not.toBeNull();
			expect(result!.filled).toBe(true);
			expect(result!.hit).toBe('take_profit');
		});

		it('should detect stop loss hit on short position', () => {
			const snapshot: IFillSnapshot = {
				bid: '99.00',
				ask: '99.10',
				last: '99.05',
				mark: '99.05',
				high: '100.50', // bar touched above SL
				low: '98.00',
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'short',
				size: '1.0',
				stopLoss: '100.50',
				takeProfit: '99.00',
				timeStopDeadlineMs: null,
			};

			const ticks: ITickAggregateSnapshot[] = [
				{ high: '99.50', low: '98.50', close: '99.00', ts: new Date(2000) },
				{ high: '100.50', low: '99.50', close: '100.00', ts: new Date(3000) }, // SL hit
			];

			const result = applyIntraBarStop(snapshot, position, ticks, 1000);

			expect(result).not.toBeNull();
			expect(result!.filled).toBe(true);
			expect(result!.hit).toBe('stop_loss');
		});

		it('should return null when neither SL nor TP hit', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '100.50',
				low: '99.50',
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'long',
				size: '1.0',
				stopLoss: '99.00',
				takeProfit: '101.00',
				timeStopDeadlineMs: null,
			};

			const ticks: ITickAggregateSnapshot[] = [
				{ high: '100.50', low: '99.50', close: '100.00', ts: new Date(2000) },
			];

			const result = applyIntraBarStop(snapshot, position, ticks, 1000);

			expect(result).toBeNull();
		});

		it('should prioritize SL when both hit in same tick', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.50', // touches TP
				low: '98.50', // touches SL
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'long',
				size: '1.0',
				stopLoss: '99.00',
				takeProfit: '101.00',
				timeStopDeadlineMs: null,
			};

			const ticks: ITickAggregateSnapshot[] = [
				{ high: '101.50', low: '98.50', close: '100.00', ts: new Date(2000) }, // both hit
			];

			const result = applyIntraBarStop(snapshot, position, ticks, 1000);

			expect(result).not.toBeNull();
			expect(result!.hit).toBe('stop_loss'); // SL wins on tie
		});

		it('should use bar extremes when no ticks available (lowFidelity)', () => {
			const snapshot: IFillSnapshot = {
				bid: '100.00',
				ask: '100.10',
				last: '100.05',
				mark: '100.05',
				high: '101.50',
				low: '98.50',
				ts: 1000,
			};

			const position: IFillPosition = {
				entryPrice: '100.00',
				side: 'long',
				size: '1.0',
				stopLoss: '99.00',
				takeProfit: '101.00',
				timeStopDeadlineMs: null,
			};

			const result = applyIntraBarStop(snapshot, position, [], 1000);

			expect(result).not.toBeNull();
			expect(result!.hit).toBe('stop_loss'); // SL fires first
			expect(result!.lowFidelity).toBe(true);
		});
	});
});
