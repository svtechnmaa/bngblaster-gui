/** Login page — local + SSO (Google / Keycloak). */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuthStore } from '../store/useAuthStore';

interface Providers { local: boolean; google: boolean; keycloak: boolean; }

export default function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [providers, setProviders] = useState<Providers>({ local: true, google: false, keycloak: false });
    const { login } = useAuthStore();
    const navigate = useNavigate();

    useEffect(() => {
        api.get('/auth/providers').then(r => setProviders(r.data)).catch(() => {});
    }, []);

    const handleSSO = async (provider: 'google' | 'keycloak') => {
        try {
            const { data } = await api.get(`/auth/${provider}/login`);
            window.location.href = data.auth_url;
        } catch {
            setError(`Failed to initiate ${provider} sign-in`);
        }
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const { data } = await api.post('/auth/login', { username, password });
            login(data.access_token, data.user);
            navigate('/');
        } catch (err: any) {
            setError(err.response?.data?.detail || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)] p-4">
            <div className="w-full max-w-md">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-400 mb-4 shadow-lg">
                        {/* Oscilloscope / measurement icon */}
                        <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12h3l3-9 4 18 3-9h7" />
                        </svg>
                    </div>
                    <h1 className="text-2xl font-bold text-[var(--text-primary)]">BNGBlaster Web Client</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-1">Network Test &amp; Measurement Console</p>
                </div>

                <form onSubmit={handleSubmit} className="glass-card p-6 space-y-4">
                    {error && (
                        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <div>
                        <label htmlFor="login-username" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Username</label>
                        <input
                            id="login-username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="input-field"
                            placeholder="Enter username"
                            autoFocus
                            required
                        />
                    </div>

                    <div>
                        <label htmlFor="login-password" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Password</label>
                        <input
                            id="login-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="input-field"
                            placeholder="Enter password"
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn-primary w-full justify-center py-2.5 disabled:opacity-50"
                    >
                        {loading ? 'Signing in…' : 'Sign In'}
                    </button>

                    {(providers.google || providers.keycloak) && (
                        <>
                            <div className="relative flex items-center gap-3 py-1">
                                <div className="flex-1 border-t border-[var(--border-color)]" />
                                <span className="text-xs text-[var(--text-muted)]">or continue with</span>
                                <div className="flex-1 border-t border-[var(--border-color)]" />
                            </div>
                            <div className="space-y-2">
                                {providers.google && (
                                    <button
                                        type="button"
                                        onClick={() => handleSSO('google')}
                                        className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-lg bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border-color)] text-sm font-medium"
                                    >
                                        <svg className="w-4 h-4" viewBox="0 0 48 48">
                                            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                                            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                                            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                                            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                                        </svg>
                                        Sign in with Google
                                    </button>
                                )}
                                {providers.keycloak && (
                                    <button
                                        type="button"
                                        onClick={() => handleSSO('keycloak')}
                                        className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-lg border border-[var(--border-color)] bg-[#0e75b6] hover:bg-[#0a5f93] text-sm font-medium text-white"
                                    >
                                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12.65 10A6 6 0 1 0 11 13H13v2h2v-2h2v-2h-4.35zM7 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
                                        </svg>
                                        Sign in with Keycloak
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </form>
            </div>
        </div>
    );
}
