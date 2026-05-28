import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from 'dotenv';

export default function globalSetup(): void {
    const envLocal = resolve(__dirname, '../../../../.env.local');
    if (existsSync(envLocal)) {
        config({ path: envLocal, override: false });
    }
}
