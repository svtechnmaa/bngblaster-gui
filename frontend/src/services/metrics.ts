import api from './api';

export interface DashboardStats {
    totals: {
        users: number;
        servers: number;
        configs: number;
        pageviews_7d: number;
        pageviews_30d: number;
    };
    pageviews_daily: { date: string; count: number }[];
    own_configs: number;
    role: string;
    users_by_role?: { role: string; count: number }[];
    users_by_provider?: { provider: string; count: number }[];
    top_config_owners?: { username: string; count: number }[];
    active_users_7d?: number;
}

export async function trackPageview(path: string): Promise<void> {
    try {
        await api.post('/metrics/pageview', { path });
    } catch {
        // Silent — tracking must never break the UI.
    }
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
    const { data } = await api.get<DashboardStats>('/dashboard/stats');
    return data;
}
