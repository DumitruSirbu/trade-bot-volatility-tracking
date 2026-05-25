import { AuthScopeEnum } from '../enum/AuthScopeEnum.js';

export interface IAuthSubject {
    sub: string;
    jti: string;
    scopes: AuthScopeEnum[];
    exp: number;
    iat: number;
}
