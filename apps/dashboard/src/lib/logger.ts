// Tiny logger shim. `no-console` only allows warn/error in committed code;
// info-level diagnostics route here and stay disabled by default. Flip the
// runtime flag via `localStorage.setItem('dashboard:debug', '1')` when needed.

const isDebugEnabled = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        return window.localStorage.getItem('dashboard:debug') === '1';
    } catch {
        return false;
    }
};

export const logger = {
    debug: (...args: unknown[]): void => {
        if (!isDebugEnabled()) {
            return;
        }

        console.warn('[dashboard:debug]', ...args);
    },
    warn: (...args: unknown[]): void => {
        console.warn('[dashboard]', ...args);
    },
    error: (...args: unknown[]): void => {
        console.error('[dashboard]', ...args);
    },
};
