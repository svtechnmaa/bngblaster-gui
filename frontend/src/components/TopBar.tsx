/** Minimal top bar — branding + user menu (no sidebar). */

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { can, type Role } from '../utils/permissions';
import InstrumentRail from './InstrumentRail';

export default function TopBar() {
    const { user, logout } = useAuthStore();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const role = (user?.role || 'viewer') as Role;
    const showRail = pathname === '/';

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    return (
        <header className="glass-topbar sticky top-0 z-30 flex items-center justify-between px-5 py-2.5 border-b border-[var(--border-color)]">
            {/* Brand */}
            <Link to="/" className="flex items-center gap-2.5 shrink-0">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-cyan-400 flex items-center justify-center shadow">
                    <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12h3l3-9 4 18 3-9h7" />
                    </svg>
                </div>
                <div className="leading-tight hidden sm:block">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">BNGBlaster Web Client</p>
                    <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Test &amp; Measurement</p>
                </div>
            </Link>

            {/* Instrument telemetry rail — same row as the brand (console route only) */}
            {showRail && (
                <div className="flex-1 flex justify-center min-w-0 px-3">
                    <InstrumentRail />
                </div>
            )}

            {/* User */}
            <div className="relative shrink-0" ref={menuRef}>
                <button
                    onClick={() => setMenuOpen(o => !o)}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                >
                    {user?.avatar_url ? (
                        <img src={user.avatar_url} alt="" className="w-7 h-7 rounded-full" />
                    ) : (
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-white text-xs font-bold">
                            {(user?.full_name || user?.username || '?').slice(0, 1).toUpperCase()}
                        </div>
                    )}
                    <div className="text-left leading-tight hidden sm:block">
                        <p className="text-xs font-medium text-[var(--text-primary)]">{user?.full_name || user?.username}</p>
                        <p className="text-[10px] text-[var(--text-muted)] uppercase">{role}</p>
                    </div>
                </button>

                {menuOpen && (
                    <div className="absolute right-0 mt-2 w-56 glass-card py-1 z-40">
                        <div className="px-3 py-2 border-b border-[var(--border-color)]">
                            <p className="text-sm font-medium text-[var(--text-primary)] truncate">{user?.full_name || user?.username}</p>
                            <p className="text-xs text-[var(--text-muted)] truncate">{user?.email || '—'}</p>
                        </div>
                        {can.manageUsers(role) && (
                            <Link
                                to="/admin/users"
                                onClick={() => setMenuOpen(false)}
                                className="block px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            >
                                User Management
                            </Link>
                        )}
                        {role === 'admin' && (
                            <Link
                                to="/admin/settings"
                                onClick={() => setMenuOpen(false)}
                                className="block px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            >
                                Admin Settings
                            </Link>
                        )}
                        <button
                            onClick={handleLogout}
                            className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-500/10"
                        >
                            Sign Out
                        </button>
                    </div>
                )}
            </div>
        </header>
    );
}
