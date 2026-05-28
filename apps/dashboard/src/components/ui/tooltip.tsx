import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { cn } from '@/lib/utils';

interface ITooltipProps {
    content: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

interface IPosition {
    top: number;
    left: number;
    placement: 'top' | 'bottom';
}

const TOOLTIP_ESTIMATED_HEIGHT = 400;

export const Tooltip = ({ content, children, className }: ITooltipProps): React.ReactElement => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [pos, setPos] = React.useState<IPosition>({ top: 0, left: 0, placement: 'top' });
    const triggerRef = React.useRef<HTMLSpanElement>(null);

    const show = (): void => {
        if (triggerRef.current !== null) {
            const rect = triggerRef.current.getBoundingClientRect();
            const spaceAbove = rect.top;
            const placement = spaceAbove < TOOLTIP_ESTIMATED_HEIGHT ? 'bottom' : 'top';

            setPos({
                top: placement === 'top' ? rect.top + window.scrollY - 8 : rect.bottom + window.scrollY + 8,
                left: rect.left + window.scrollX + rect.width / 2,
                placement,
            });
        }

        setIsOpen(true);
    };

    const hide = (): void => setIsOpen(false);

    const translateY = pos.placement === 'top' ? '-translate-y-full' : 'translate-y-0';

    return (
        <span ref={triggerRef} className="relative inline-flex items-center" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
            <span tabIndex={0} className="inline-flex items-center outline-none">
                {children}
            </span>
            {isOpen &&
                ReactDOM.createPortal(
                    <span
                        role="tooltip"
                        style={{ top: pos.top, left: pos.left }}
                        className={cn(
                            'pointer-events-none fixed z-[9999] -translate-x-1/2 w-72 max-h-96 overflow-y-auto rounded-md border bg-popover px-3 py-2 text-xs font-normal normal-case tracking-normal text-popover-foreground shadow-md',
                            translateY,
                            className,
                        )}
                    >
                        {content}
                    </span>,
                    document.body,
                )}
        </span>
    );
};
