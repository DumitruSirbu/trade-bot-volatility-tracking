import * as React from 'react';
import { READ_API_PATHS, type ILoginRequest, type ILoginResponse } from '@bot/shared';

import { apiClient, AUTH_EXPIRED_EVENT, TOKEN_STORAGE_KEY } from '@/api/apiClient';
import { setSocketToken } from '@/realtime/liveSocket';

interface IAuthSession {
    token: string;
    expiresAt: string;
    subject: string;
}

interface IAuthContextValue {
    session: IAuthSession | null;
    isAuthenticated: boolean;
    login: (secret: string) => Promise<void>;
    logout: () => void;
}

const AuthContext = React.createContext<IAuthContextValue | null>(null);

const SESSION_STORAGE_META_KEY = 'dashboard:auth-meta';

interface IPersistedMeta {
    expiresAt: string;
    subject: string;
}

const readPersistedSession = (): IAuthSession | null => {
    try {
        const token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
        const metaRaw = window.sessionStorage.getItem(SESSION_STORAGE_META_KEY);

        if (!token || !metaRaw) {
            return null;
        }

        const meta = JSON.parse(metaRaw) as IPersistedMeta;

        if (Date.parse(meta.expiresAt) <= Date.now()) {
            return null;
        }

        return { token, expiresAt: meta.expiresAt, subject: meta.subject };
    } catch {
        return null;
    }
};

const persistSession = (session: IAuthSession): void => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, session.token);
    const meta: IPersistedMeta = { expiresAt: session.expiresAt, subject: session.subject };
    window.sessionStorage.setItem(SESSION_STORAGE_META_KEY, JSON.stringify(meta));
};

const clearPersistedSession = (): void => {
    try {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        window.sessionStorage.removeItem(SESSION_STORAGE_META_KEY);
    } catch {
        /* storage may be disabled */
    }
};

export const AuthProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => {
    const [session, setSession] = React.useState<IAuthSession | null>(() => readPersistedSession());

    const logout = React.useCallback((): void => {
        clearPersistedSession();
        setSession(null);
    }, []);

    const login = React.useCallback(async (secret: string): Promise<void> => {
        const body: ILoginRequest = { secret };
        const response = await apiClient.post<ILoginResponse>(READ_API_PATHS.authLogin, body, { skipAuth: true });
        const next: IAuthSession = { token: response.token, expiresAt: response.expiresAt, subject: response.subject };
        persistSession(next);
        setSession(next);
    }, []);

    React.useEffect(() => {
        const handleExpired = (): void => {
            // Round-1 logic fix: drop the live socket synchronously so the
            // WS connection cannot continue holding the now-stale token while
            // the next React effect tears down the UI. Order: socket first
            // (network side-effect), then in-React state cleanup.
            setSocketToken(null);
            clearPersistedSession();
            setSession(null);
        };

        window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);

        return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    }, []);

    const value = React.useMemo<IAuthContextValue>(() => ({ session, isAuthenticated: session !== null, login, logout }), [session, login, logout]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): IAuthContextValue => {
    const value = React.useContext(AuthContext);

    if (value === null) {
        throw new Error('useAuth must be used inside an AuthProvider');
    }

    return value;
};
