/** Admin-only user management page. */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import api from '../../services/api';

interface User {
    id: number;
    username: string;
    email: string | null;
    full_name: string | null;
    role: string;
    is_active: number;
    auth_provider: string;
}

const ROLES = ['admin', 'operator', 'viewer'];

export default function UsersPage() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);

    const load = () =>
        api.get('/auth/users')
            .then(r => setUsers(r.data))
            .catch(e => toast.error(e.response?.data?.detail || 'Failed to load users'))
            .finally(() => setLoading(false));

    useEffect(() => { load(); }, []);

    const updateUser = async (id: number, patch: Partial<User>) => {
        try {
            await api.put(`/auth/users/${id}`, patch);
            toast.success('User updated');
            load();
        } catch (e: any) {
            toast.error(e.response?.data?.detail || 'Update failed');
        }
    };

    const deleteUser = async (id: number, username: string) => {
        if (!confirm(`Delete user "${username}"?`)) return;
        try {
            await api.delete(`/auth/users/${id}`);
            toast.success('User deleted');
            load();
        } catch (e: any) {
            toast.error(e.response?.data?.detail || 'Delete failed');
        }
    };

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h1 className="text-xl font-semibold text-[var(--text-primary)]">User Management</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-0.5">Manage user roles, status, and access</p>
                </div>
                <button onClick={() => setShowCreate(true)} className="btn-primary">
                    + New User
                </button>
            </div>

            <div className="glass-card overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-sm text-[var(--text-muted)]">Loading…</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-[var(--bg-hover)] text-xs uppercase tracking-wider text-[var(--text-muted)]">
                            <tr>
                                <th className="text-left px-4 py-2.5">Username</th>
                                <th className="text-left px-4 py-2.5">Full Name</th>
                                <th className="text-left px-4 py-2.5">Email</th>
                                <th className="text-left px-4 py-2.5">Provider</th>
                                <th className="text-left px-4 py-2.5">Role</th>
                                <th className="text-left px-4 py-2.5">Active</th>
                                <th className="px-4 py-2.5"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map(u => (
                                <tr key={u.id} className="border-t border-[var(--border-color)]">
                                    <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">{u.username}</td>
                                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">{u.full_name || '—'}</td>
                                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">{u.email || '—'}</td>
                                    <td className="px-4 py-2.5">
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 uppercase">
                                            {u.auth_provider}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <select
                                            value={u.role}
                                            onChange={e => updateUser(u.id, { role: e.target.value })}
                                            className="input-field text-xs py-1"
                                            disabled={u.username === 'admin'}
                                        >
                                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <input
                                            type="checkbox"
                                            checked={!!u.is_active}
                                            disabled={u.username === 'admin'}
                                            onChange={e => updateUser(u.id, { is_active: e.target.checked ? 1 : 0 })}
                                        />
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        {u.username !== 'admin' && (
                                            <button
                                                onClick={() => deleteUser(u.id, u.username)}
                                                className="text-xs text-red-500 hover:text-red-700"
                                            >
                                                Delete
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={load} />}
        </div>
    );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const [data, setData] = useState({ username: '', password: '', email: '', full_name: '', role: 'operator' });
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!data.username || !data.password) return toast.error('Username and password required');
        setSaving(true);
        try {
            await api.post('/auth/register', data);
            toast.success('User created');
            onCreated();
            onClose();
        } catch (e: any) {
            toast.error(e.response?.data?.detail || 'Create failed');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <div className="glass-card w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
                <h2 className="text-base font-semibold mb-4 text-[var(--text-primary)]">Create User</h2>
                <div className="space-y-3">
                    <input className="input-field" placeholder="Username *" value={data.username}
                        onChange={e => setData({ ...data, username: e.target.value })} />
                    <input className="input-field" type="password" placeholder="Password *" value={data.password}
                        onChange={e => setData({ ...data, password: e.target.value })} />
                    <input className="input-field" placeholder="Email" value={data.email}
                        onChange={e => setData({ ...data, email: e.target.value })} />
                    <input className="input-field" placeholder="Full name" value={data.full_name}
                        onChange={e => setData({ ...data, full_name: e.target.value })} />
                    <select className="input-field" value={data.role}
                        onChange={e => setData({ ...data, role: e.target.value })}>
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                </div>
                <div className="flex justify-end gap-2 mt-5">
                    <button className="btn-ghost" onClick={onClose}>Cancel</button>
                    <button className="btn-primary" onClick={submit} disabled={saving}>
                        {saving ? 'Creating…' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
}
