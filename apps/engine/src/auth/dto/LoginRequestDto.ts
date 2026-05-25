import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { LOGIN_SECRET_MAX_LEN } from '../const/authConsts';

// M10 R2 #1 (Security MED). Strict request shape for POST /v1/auth/login.
//
// The global ValidationPipe (main.ts) runs with `whitelist: true` +
// `forbidNonWhitelisted: true` + `transform: true`, so:
//   - extra fields (e.g. `{ scope: 'admin' }`) trigger a 400 — admin can
//     never reach the mint path through a body smuggle.
//   - missing / non-string / empty `secret` triggers a 400.
//   - oversized `secret` (> LOGIN_SECRET_MAX_LEN bytes) triggers a 400 BEFORE
//     the SHA-256 hash + timingSafeEqual, capping CPU per request.
//
// The controller maps the pipe's 400 to the canonical IAuthFailure 401
// MALFORMED envelope (no oracle leak distinguishing "bad shape" from
// "bad secret beyond shape").
export class LoginRequestDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(LOGIN_SECRET_MAX_LEN)
    secret!: string;
}
