/**
 * App — single-page BNGBlaster console.
 *
 * Routes:
 *   /login            → local + SSO login
 *   /oauth-callback   → SSO redirect target
 *   /                 → BNGBlaster page (auth required)
 *   /admin/users      → user management (admin only)
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import BNGBlasterPage from './components/BNGBlasterPage';
import Login from './components/Login';
import OAuthCallback from './components/OAuthCallback';
import TopBar from './components/TopBar';
import SettingsPage from './components/admin/SettingsPage';
import UsersPage from './components/admin/UsersPage';
import { trackPageview } from './services/metrics';
import { useAuthStore } from './store/useAuthStore';

function PageviewTracker() {
    const { pathname } = useLocation();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    useEffect(() => {
        if (isAuthenticated) trackPageview(pathname);
    }, [pathname, isAuthenticated]);
    return null;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
    const { isAuthenticated } = useAuthStore();
    return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
    const { user, isAuthenticated } = useAuthStore();
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    if (user?.role !== 'admin') return <Navigate to="/" replace />;
    return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col bg-[var(--bg-primary)]">
            <TopBar />
            <main className="flex-1 overflow-y-auto max-w-[1600px] mx-auto w-full px-3 sm:px-4 lg:px-6 py-4">{children}</main>
        </div>
    );
}

export default function App() {
    return (
        <>
        <PageviewTracker />
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/oauth-callback" element={<OAuthCallback />} />
            <Route path="/" element={<RequireAuth><Shell><BNGBlasterPage /></Shell></RequireAuth>} />
            <Route path="/admin/users" element={<RequireAdmin><Shell><UsersPage /></Shell></RequireAdmin>} />
            <Route path="/admin/settings" element={<RequireAdmin><Shell><SettingsPage /></Shell></RequireAdmin>} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </>
    );
}
