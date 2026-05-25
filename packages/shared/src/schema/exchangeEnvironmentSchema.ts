import { z } from 'zod';
import { ExchangeEnvironmentEnum } from '../enum/ExchangeEnvironmentEnum.js';

// M11a W0.1: Validates EXCHANGE_ENV string to ExchangeEnvironmentEnum.
// Rejects unset values — no silent defaults.
export const exchangeEnvironmentSchema = z
	.nativeEnum(ExchangeEnvironmentEnum)
	.refine((val) => val !== undefined && val !== null, {
		message: 'EXCHANGE_ENV must be set to one of: testnet, demo, live',
	});

export type IExchangeEnvironment = z.infer<typeof exchangeEnvironmentSchema>;
