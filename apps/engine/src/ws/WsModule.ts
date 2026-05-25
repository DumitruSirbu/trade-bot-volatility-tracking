import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/AuthModule';
import { PositionModule } from '../position/PositionModule';
import { LiveGateway } from './LiveGateway';
import { WS_CLOCK, WsAuthAdapter } from './auth/WsAuthHandshake';

// M9 W5 (ADR 0023). Mechanical wiring for the live WS gateway. Two providers:
//
//   - `WsAuthAdapter` — wraps the AuthModule helper for socket.io's handshake
//     + ships the 30s re-auth sweeper.
//   - `LiveGateway` — the socket.io gateway itself; @OnEvent listeners are
//     auto-registered by @nestjs/event-emitter once the provider exists.
//
// `WS_CLOCK` is bound to `Date.now` in production; tests rebind via
// `Test.createTestingModule(...).overrideProvider(WS_CLOCK).useValue(...)`.
//
// CORS: socket.io reads `AUTH_CORS_ALLOWLIST` at @WebSocketGateway-decorator
// evaluation time (LiveGateway.ts), so the env must be set BEFORE Nest
// instantiates the class. AppConfigService already loads dotenv at module
// init — no extra wiring needed.

@Module({
    imports: [AuthModule, PositionModule],
    providers: [{ provide: WS_CLOCK, useValue: (): number => Date.now() }, WsAuthAdapter, LiveGateway],
    exports: [LiveGateway],
})
export class WsModule {}
