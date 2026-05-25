import * as React from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LiveStatusPill } from '@/realtime/LiveWsProvider';
import { AccountStrip } from '@/views/AccountStrip';
import { DecisionsFeed } from '@/views/DecisionsFeed';
import { HaltBanner } from '@/views/HaltBanner';
import { HaltHistoryDrawer } from '@/views/HaltHistoryDrawer';
import { KillSwitchControl } from '@/views/KillSwitchButton';
import { PerformanceByVersion } from '@/views/PerformanceByVersion';
import { PositionsTable } from '@/views/PositionsTable';

type TabId = 'positions' | 'decisions' | 'performance';

interface ITabDef {
    id: TabId;
    label: string;
    render: () => React.ReactElement;
}

const TABS: readonly ITabDef[] = [
    { id: 'positions', label: 'Positions', render: () => <PositionsTable /> },
    { id: 'decisions', label: 'Decisions', render: () => <DecisionsFeed /> },
    { id: 'performance', label: 'Performance', render: () => <PerformanceByVersion /> },
];

const TabStrip = ({ active, onSelect }: { active: TabId; onSelect: (id: TabId) => void }): React.ReactElement => (
    <nav className="flex gap-1 border-b px-6">
        {TABS.map((tab) => (
            <button
                key={tab.id}
                type="button"
                onClick={() => onSelect(tab.id)}
                className={cn(
                    'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                    tab.id === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
            >
                {tab.label}
            </button>
        ))}
    </nav>
);

interface IShellProps {
    children?: React.ReactNode;
}

export const Shell = ({ children }: IShellProps = {}): React.ReactElement => {
    const { session, logout } = useAuth();
    const [activeTab, setActiveTab] = React.useState<TabId>('positions');
    const subject = session?.subject ?? 'unknown';
    const activeDef = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];
    const hasOverride = children !== undefined && children !== null;

    return (
        <div className="flex min-h-screen flex-col">
            <header className="flex items-center justify-between border-b px-6 py-3">
                <div className="flex items-baseline gap-3">
                    <span className="text-lg font-semibold">Trade Bot</span>
                    <span className="text-sm text-muted-foreground">Operator: {subject}</span>
                </div>
                <div className="flex items-center gap-3">
                    <LiveStatusPill />
                    <HaltHistoryDrawer />
                    <KillSwitchControl />
                    <Button variant="outline" size="sm" onClick={logout}>
                        Log out
                    </Button>
                </div>
            </header>
            <HaltBanner />
            <AccountStrip />
            {!hasOverride && <TabStrip active={activeTab} onSelect={setActiveTab} />}
            <main className="flex-1">{hasOverride ? children : <div className="px-6 py-4">{activeDef.render()}</div>}</main>
        </div>
    );
};
