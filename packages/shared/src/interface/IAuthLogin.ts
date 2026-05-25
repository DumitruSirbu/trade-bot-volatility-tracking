import { AuthScopeEnum } from '../enum/AuthScopeEnum.js';

export interface ILoginRequest {
    secret: string;
}

export interface ILoginResponse {
    token: string;
    expiresAt: string;
    scopes: AuthScopeEnum[];
    subject: string;
}
