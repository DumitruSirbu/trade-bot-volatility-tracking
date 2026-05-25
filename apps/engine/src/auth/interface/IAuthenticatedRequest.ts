import { IAuthSubject } from '@bot/shared';
import { Request } from 'express';

// M9 R1 #5 — single definition of the express-Request augmentation the
// `AuthGuard` stamps on every authenticated handler. Previously duplicated in
// `AuthGuard.ts` and `HaltController.ts`; routing both to this file removes
// the duplicate and the drift risk if `IAuthSubject` ever gains a field.
export interface IAuthenticatedRequest extends Request {
    authSubject?: IAuthSubject;
}
