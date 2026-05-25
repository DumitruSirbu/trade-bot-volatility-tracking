import { AlertTypeEnum } from '../enum/AlertTypeEnum.js';
import { AlertSeverityEnum } from '../enum/AlertSeverityEnum.js';

export interface IAlertPayload {
    type: AlertTypeEnum;
    severity: AlertSeverityEnum;
    occurredAt: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}
