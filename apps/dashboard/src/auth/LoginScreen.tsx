import * as React from 'react';
import { AuthFailureReasonEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const NETWORK_ERROR_MESSAGE = 'Network unreachable. Verify the engine is running on :3000.';
const GENERIC_ERROR_MESSAGE = 'Login failed. Try again.';

const messageForApiError = (error: ApiError): string => {
    if (error.status === 429) {
        const retryAfter = error.retryAfterSec ?? 60;

        return `Rate limited. Retry in ${retryAfter}s.`;
    }

    if (error.code === AuthFailureReasonEnum.BAD_SECRET.toUpperCase()) {
        return 'Wrong bootstrap secret.';
    }

    if (error.code === AuthFailureReasonEnum.MALFORMED.toUpperCase()) {
        return 'Malformed login request. Enter the secret and try again.';
    }

    return error.message || GENERIC_ERROR_MESSAGE;
};

const messageForUnknown = (error: unknown): string => {
    if (error instanceof ApiError) {
        return messageForApiError(error);
    }

    if (error instanceof TypeError) {
        return NETWORK_ERROR_MESSAGE;
    }

    return GENERIC_ERROR_MESSAGE;
};

export const LoginScreen = (): React.ReactElement => {
    const { login } = useAuth();
    const [secret, setSecret] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const isSubmitDisabled = isSubmitting || secret.trim().length === 0;

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        if (isSubmitDisabled) {
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            await login(secret);
            setSecret('');
        } catch (loginError: unknown) {
            setError(messageForUnknown(loginError));
            setSecret('');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Operator login</CardTitle>
                    <CardDescription>Enter the engine bootstrap secret to start a session.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="bootstrap-secret">Bootstrap secret</Label>
                            <Input
                                id="bootstrap-secret"
                                type="password"
                                autoComplete="current-password"
                                autoFocus
                                value={secret}
                                onChange={(event) => setSecret(event.target.value)}
                                disabled={isSubmitting}
                            />
                        </div>
                        {error !== null && (
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                        )}
                        <Button type="submit" disabled={isSubmitDisabled}>
                            {isSubmitting ? 'Signing in…' : 'Sign in'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
};
