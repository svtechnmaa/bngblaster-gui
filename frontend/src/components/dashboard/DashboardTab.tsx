import { useEffect, useState } from 'react';
import {
    Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
    Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
    UsersIcon, ServerIcon, Cog6ToothIcon, EyeIcon,
} from '@heroicons/react/24/outline';

import { fetchDashboardStats, type DashboardStats } from '../../services/metrics';

const PALETTE = ['#0891b2', '#7c3aed', '#ea580c', '#059669', '#db2777', '#d97706'];

function StatCard({ icon: Icon, label, value, accent }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: number | string;
    accent: string;
}) {
    return (
        <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-[var(--shadow-sm)]">
            <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">{label}</span>
                <span style={{ color: accent }}><Icon className="w-5 h-5" /></span>
            </div>
            <div className="text-3xl font-semibold text-[var(--text-primary)]">{value}</div>
        </div>
    );
}

function ChartCard({ title, children, height = 280 }: {
    title: string; children: React.ReactNode; height?: number;
}) {
    return (
        <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-[var(--shadow-sm)]">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">{title}</h3>
            <div style={{ width: '100%', height }}>
                <ResponsiveContainer>{children as React.ReactElement}</ResponsiveContainer>
            </div>
        </div>
    );
}

export default function DashboardTab() {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchDashboardStats()
            .then((s) => { if (!cancelled) setStats(s); })
            .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load stats'); });
        return () => { cancelled = true; };
    }, []);

    if (error) {
        return <div className="p-8 text-[var(--color-danger)]">Error: {error}</div>;
    }
    if (!stats) {
        return <div className="p-8 text-[var(--text-muted)]">Loading…</div>;
    }

    const canSeeUserStats = stats.role === 'admin' || stats.role === 'operator';
    const { totals } = stats;

    return (
        <div className="p-6 space-y-6">
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {canSeeUserStats && (
                    <StatCard icon={UsersIcon} label="Users" value={totals.users} accent="var(--accent-cyan)" />
                )}
                <StatCard icon={ServerIcon} label="BNG Servers" value={totals.servers} accent="var(--accent-purple)" />
                <StatCard icon={Cog6ToothIcon} label="Configs" value={totals.configs} accent="var(--accent-orange)" />
                <StatCard icon={EyeIcon} label="Page views (7d)" value={totals.pageviews_7d} accent="var(--accent-green)" />
                {!canSeeUserStats && (
                    <StatCard icon={Cog6ToothIcon} label="My configs" value={stats.own_configs} accent="var(--accent-pink)" />
                )}
            </div>

            {/* Pageviews line chart */}
            <ChartCard title="Page views — last 30 days">
                <LineChart data={stats.pageviews_daily} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
                    <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" allowDecimals={false} />
                    <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                    <Line type="monotone" dataKey="count" stroke="var(--accent-cyan)" strokeWidth={2} dot={false} />
                </LineChart>
            </ChartCard>

            {canSeeUserStats && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Users by role donut */}
                    <ChartCard title="Users by role">
                        <PieChart>
                            <Pie
                                data={stats.users_by_role ?? []}
                                dataKey="count"
                                nameKey="role"
                                innerRadius={55}
                                outerRadius={90}
                                paddingAngle={2}
                            >
                                {(stats.users_by_role ?? []).map((_, i) => (
                                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                                ))}
                            </Pie>
                            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                            <Legend />
                        </PieChart>
                    </ChartCard>

                    {/* Top owners bar */}
                    <ChartCard title="Top 5 config owners">
                        <BarChart data={stats.top_config_owners ?? []} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                            <XAxis dataKey="username" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
                            <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" allowDecimals={false} />
                            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                            <Bar dataKey="count" fill="var(--accent-purple)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ChartCard>
                </div>
            )}

            {canSeeUserStats && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <StatCard
                        icon={UsersIcon}
                        label="Active users (7d)"
                        value={stats.active_users_7d ?? 0}
                        accent="var(--accent-cyan)"
                    />
                    <StatCard
                        icon={EyeIcon}
                        label="Page views (30d)"
                        value={totals.pageviews_30d}
                        accent="var(--accent-green)"
                    />
                    <StatCard
                        icon={Cog6ToothIcon}
                        label="My configs"
                        value={stats.own_configs}
                        accent="var(--accent-pink)"
                    />
                </div>
            )}
        </div>
    );
}
