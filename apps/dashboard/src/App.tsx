import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { ApiError } from '@/api/apiClient';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { LoginScreen } from '@/auth/LoginScreen';
import { Shell } from '@/shell/Shell';
import { logger } from '@/lib/logger';
import { LiveWsProvider } from '@/realtime/LiveWsProvider';
import { PositionDetail } from '@/views/PositionDetail';

const buildQueryClient = (): QueryClient =>
    new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                gcTime: 5 * 60_000,
                refetchOnWindowFocus: false,
                retry: (failureCount, error) => {
                    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                        return false;
                    }

                    return failureCount < 2;
                },
            },
            mutations: {
                onError: (error) => logger.warn('mutation failed', error),
            },
        },
    });

const AuthedRoutes = (): React.ReactElement => (
    <Routes>
        <Route path="/" element={<Shell />} />
        <Route
            path="/positions/:id"
            element={
                <Shell>
                    <PositionDetail />
                </Shell>
            }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
);

const Gate = (): React.ReactElement => {
    const { isAuthenticated } = useAuth();

    return isAuthenticated ? <AuthedRoutes /> : <LoginScreen />;
};

export const App = (): React.ReactElement => {
    const [queryClient] = React.useState(buildQueryClient);

    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <AuthProvider>
                    <LiveWsProvider>
                        <Gate />
                    </LiveWsProvider>
                </AuthProvider>
            </BrowserRouter>
        </QueryClientProvider>
    );
};
