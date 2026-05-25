import { AuthFailureReasonEnum } from '../enum/AuthFailureReasonEnum.js';

export interface IAuthFailure {
    error: 'AUTH_FAILED';
    reason: AuthFailureReasonEnum;
}
