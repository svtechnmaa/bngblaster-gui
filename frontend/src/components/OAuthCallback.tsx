/** OAuthCallback — handles redirect from SSO providers after successful login. */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';

export default function OAuthCallback() {
    const navigate = useNavigate();
    const { login } = useAuthStore();

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');
        const userStr = params.get('user');

        if (token && userStr) {
            try {
                const user = JSON.parse(decodeURIComponent(userStr));
                login(token, user);
            } catch { /* malformed — fall through to redirect */ }
        }
        navigate('/', { replace: true });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
            <p className="text-sm text-[var(--text-muted)]">Completing sign-in…</p>
        </div>
    );
}
