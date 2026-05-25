export interface IHealthView {
    status: 'ok' | 'degraded';
    uptimeSec: number;
    schemaValid: boolean;
}
