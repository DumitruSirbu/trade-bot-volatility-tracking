import * as React from 'react';

import { ApiError } from '@/api/apiClient';
import { useHaltMutation, useResumeMutation } from '@/api/mutations';
import { useRiskState } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// M10 W4 (ADR 0021, ADR 0026 §2.6). Operator kill-switch + symmetric resume.
//
// Hard contract: confirm text is STRICT case-sensitive equality to the literal
// 'HALT' / 'RESUME'. Reason is required (trimmed, non-empty). Flatten defaults
// OFF — mirroring the engine default per ADR 0021 §2.4. The typed reason is
// never persisted; it lives only in component state.

const HALT_CONFIRM_WORD = 'HALT';
const RESUME_CONFIRM_WORD = 'RESUME';
const REASON_MAX_LEN = 256;

// Shared dialog lifecycle for both Halt and Resume buttons: caller passes a
// form-reset callback; the hook owns `open` state and ensures reset on close.
interface IDialogWithResetApi {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    handleOpenChange: (next: boolean) => void;
}

const useDialogWithReset = (resetForm: () => void): IDialogWithResetApi => {
    const [open, setOpen] = React.useState(false);

    const handleOpenChange = React.useCallback(
        (next: boolean): void => {
            setOpen(next);
            if (!next) {
                resetForm();
            }
        },
        [resetForm],
    );

    return { open, setOpen, handleOpenChange };
};

const isHalted = (raw: boolean | undefined): boolean => raw === true;

const errorMessage = (err: unknown): string => {
    if (err instanceof ApiError) {
        if (err.code === 'RATE_LIMITED' && err.retryAfterSec !== undefined) {
            return `Throttled. Retry in ${err.retryAfterSec}s.`;
        }

        return `${err.code}: ${err.message}`;
    }

    if (err instanceof Error) {
        return err.message;
    }

    return 'Request failed.';
};

export const KillSwitchControl = (): React.ReactElement => {
    const { data: risk } = useRiskState();
    const halted = isHalted(risk?.isHalted);

    return halted ? <ResumeButton /> : <KillSwitchButton />;
};

export const KillSwitchButton = (): React.ReactElement => {
    const [reason, setReason] = React.useState('');
    const [flatten, setFlatten] = React.useState(false);
    const [confirmText, setConfirmText] = React.useState('');
    const mutation = useHaltMutation();

    const resetForm = React.useCallback((): void => {
        setReason('');
        setFlatten(false);
        setConfirmText('');
        mutation.reset();
    }, [mutation]);

    const { open, setOpen, handleOpenChange } = useDialogWithReset(resetForm);

    const trimmedReason = reason.trim();
    const canSubmit = trimmedReason.length > 0 && confirmText === HALT_CONFIRM_WORD && !mutation.isPending;

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!canSubmit) {
            return;
        }

        mutation.mutate(
            { reason: trimmedReason, flatten },
            {
                onSuccess: () => {
                    setOpen(false);
                    resetForm();
                },
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                    Halt trading
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Halt trading?</DialogTitle>
                    <DialogDescription>
                        Stops all new exposure. Existing positions remain under their stops unless &ldquo;Flatten open positions&rdquo; is checked.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="halt-reason">Reason (required)</Label>
                        <Textarea
                            id="halt-reason"
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            maxLength={REASON_MAX_LEN}
                            required
                            autoComplete="off"
                            placeholder="e.g. unusual spread widening on BTCUSDT"
                        />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={flatten} onCheckedChange={(value) => setFlatten(value === true)} />
                        <span>Flatten open positions (close to flat via reduce-market)</span>
                    </label>
                    <div className="grid gap-2">
                        <Label htmlFor="halt-confirm">
                            Type <span className="font-mono font-semibold">HALT</span> to confirm
                        </Label>
                        <Input
                            id="halt-confirm"
                            value={confirmText}
                            onChange={(event) => setConfirmText(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    {mutation.isError && <p className="text-sm text-destructive">{errorMessage(mutation.error)}</p>}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="destructive" disabled={!canSubmit}>
                            {mutation.isPending ? 'Halting…' : 'Halt trading'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export const ResumeButton = (): React.ReactElement => {
    const [reason, setReason] = React.useState('');
    const [confirmText, setConfirmText] = React.useState('');
    const mutation = useResumeMutation();

    const resetForm = React.useCallback((): void => {
        setReason('');
        setConfirmText('');
        mutation.reset();
    }, [mutation]);

    const { open, setOpen, handleOpenChange } = useDialogWithReset(resetForm);

    const trimmedReason = reason.trim();
    const canSubmit = trimmedReason.length > 0 && confirmText === RESUME_CONFIRM_WORD && !mutation.isPending;

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!canSubmit) {
            return;
        }

        mutation.mutate(
            { reason: trimmedReason },
            {
                onSuccess: () => {
                    setOpen(false);
                    resetForm();
                },
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
                <Button className="bg-emerald-600 text-white hover:bg-emerald-700" size="sm">
                    Resume trading
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Resume trading?</DialogTitle>
                    <DialogDescription>Re-enables new exposure. Confirm only after the condition that caused the halt is resolved.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="resume-reason">Reason (required)</Label>
                        <Textarea
                            id="resume-reason"
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            maxLength={REASON_MAX_LEN}
                            required
                            autoComplete="off"
                            placeholder="e.g. spreads normalised, exchange reports restored"
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="resume-confirm">
                            Type <span className="font-mono font-semibold">RESUME</span> to confirm
                        </Label>
                        <Input
                            id="resume-confirm"
                            value={confirmText}
                            onChange={(event) => setConfirmText(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    {mutation.isError && <p className="text-sm text-destructive">{errorMessage(mutation.error)}</p>}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={!canSubmit}>
                            {mutation.isPending ? 'Resuming…' : 'Resume trading'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
