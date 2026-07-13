/**
 * Admin Settings page — system-wide integration settings.
 *
 * Currently hosts Git backup config (per-installation, not per-user).
 */

import { useEffect, useState } from 'react';
import {
    ArrowPathIcon, CheckCircleIcon, CloudArrowDownIcon, CloudArrowUpIcon,
    ExclamationTriangleIcon, KeyIcon, LinkIcon,
} from '@heroicons/react/24/outline';

import api from '../../services/api';

interface GitSettings {
    git_repo_url: string;
    git_branch: string;
    git_token_set: boolean;
    updated_at?: string;
}

interface BackupResult {
    repo: string;
    branch: string;
    total: number;
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
    details: { name: string; owner: string; status: string; error?: string }[];
    timestamp: string;
}

interface RestoreResult {
    repo: string;
    branch: string;
    total: number;
    restored: number;
    skipped: number;
    failed: number;
    truncated: boolean;
    details: { name: string; owner?: string; assigned_to?: string; status: string; reason?: string; error?: string }[];
}

export default function SettingsPage() {
    const [settings, setSettings] = useState<GitSettings | null>(null);
    const [repoUrl, setRepoUrl] = useState('');
    const [branch, setBranch] = useState('main');
    const [token, setToken] = useState('');  // empty = keep existing
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [backing, setBacking] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
    const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
    const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

    useEffect(() => {
        api.get('/admin/settings/git')
            .then(r => {
                setSettings(r.data);
                setRepoUrl(r.data.git_repo_url || '');
                setBranch(r.data.git_branch || 'main');
            })
            .catch(e => setMsg({ type: 'err', text: e.response?.data?.detail || 'Failed to load settings' }));
    }, []);

    const showMsg = (type: 'ok' | 'err', text: string, ms = 5000) => {
        setMsg({ type, text });
        setTimeout(() => setMsg(null), ms);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const body: Record<string, string> = {
                git_repo_url: repoUrl,
                git_branch: branch,
            };
            if (token) body.git_token = token;
            const r = await api.put('/admin/settings/git', body);
            setSettings(r.data);
            setToken('');  // clear local token field after save
            showMsg('ok', 'Git settings saved');
        } catch (e: any) {
            showMsg('err', e.response?.data?.detail || 'Save failed');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        setTesting(true);
        try {
            const r = await api.post('/admin/settings/git/test');
            showMsg('ok', `Connected as @${r.data.github_user} to ${r.data.owner}/${r.data.repo} (branch: ${r.data.branch})`);
        } catch (e: any) {
            showMsg('err', e.response?.data?.detail || 'Test failed');
        } finally {
            setTesting(false);
        }
    };

    const handleBackup = async () => {
        if (!confirm('Backup ALL configs (from every user) to the configured Git repo?')) return;
        setBacking(true);
        setBackupResult(null);
        try {
            const r = await api.post('/admin/settings/git/backup');
            setBackupResult(r.data);
            showMsg('ok', `Backup complete: ${r.data.created} created · ${r.data.updated} updated · ${r.data.unchanged} unchanged${r.data.failed ? ` · ${r.data.failed} failed` : ''}`);
        } catch (e: any) {
            showMsg('err', e.response?.data?.detail || 'Backup failed');
        } finally {
            setBacking(false);
        }
    };

    const handleRestore = async () => {
        if (!confirm('Restore configs from the Git repo? Existing configs (same name) are left untouched; only missing ones are created.')) return;
        setRestoring(true);
        setRestoreResult(null);
        try {
            const r = await api.post('/admin/settings/git/restore');
            setRestoreResult(r.data);
            showMsg('ok', `Restore complete: ${r.data.restored} restored · ${r.data.skipped} skipped${r.data.failed ? ` · ${r.data.failed} failed` : ''}`);
        } catch (e: any) {
            showMsg('err', e.response?.data?.detail || 'Restore failed');
        } finally {
            setRestoring(false);
        }
    };

    return (
        <div className="p-6 max-w-3xl mx-auto space-y-6">
            <div>
                <h1 className="text-xl font-semibold text-[var(--text-primary)]">Admin Settings</h1>
                <p className="text-xs text-[var(--text-muted)]">System-wide integration settings (admin only).</p>
            </div>

            {/* Git Backup section */}
            <section className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-[var(--shadow-sm)]">
                <div className="flex items-center gap-2 mb-4">
                    <CloudArrowUpIcon className="w-5 h-5 text-cyan-600" />
                    <h2 className="text-base font-semibold text-[var(--text-primary)]">Git Backup &amp; Restore</h2>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                    Back up <strong>all</strong> saved BNGBlaster configs (from every user) to a GitHub repository.
                    Each config is written to <code>configs/{'{owner}'}/{'{name}'}.json</code> plus a <code>.meta.json</code> sidecar.
                    <strong> Restore</strong> pulls those files back and creates any config missing locally — configs whose name already exists are skipped (never overwritten).
                </p>

                <div className="space-y-3">
                    <div>
                        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                            <LinkIcon className="w-3 h-3 inline mr-1" />Repository URL
                        </label>
                        <input
                            type="text" value={repoUrl}
                            onChange={e => setRepoUrl(e.target.value)}
                            placeholder="https://github.com/owner/repo"
                            className="input-field text-sm font-mono"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Branch</label>
                        <input
                            type="text" value={branch}
                            onChange={e => setBranch(e.target.value)}
                            placeholder="main"
                            className="input-field text-sm font-mono max-w-xs"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                            <KeyIcon className="w-3 h-3 inline mr-1" />
                            Personal Access Token {settings?.git_token_set && <span className="text-emerald-600">· currently set</span>}
                        </label>
                        <input
                            type="password" value={token}
                            onChange={e => setToken(e.target.value)}
                            placeholder={settings?.git_token_set ? '•••••••••••• (leave blank to keep existing)' : 'ghp_xxxxxxxxxxxxxxxxxxxx'}
                            autoComplete="new-password"
                            className="input-field text-sm font-mono"
                        />
                        <p className="text-[10px] text-[var(--text-muted)] mt-1">
                            Needs <code>repo</code> scope (contents read/write). Stored encrypted at rest.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-2">
                        <button
                            onClick={handleSave}
                            disabled={saving || !repoUrl}
                            className="btn-primary text-sm disabled:opacity-50"
                        >
                            {saving ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : null}
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                            onClick={handleTest}
                            disabled={testing || !settings?.git_token_set}
                            className="btn-secondary text-sm disabled:opacity-50"
                            title={!settings?.git_token_set ? 'Save a PAT first' : 'Test connection'}
                        >
                            {testing ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <CheckCircleIcon className="w-4 h-4" />}
                            Test connection
                        </button>
                        <button
                            onClick={handleBackup}
                            disabled={backing || !settings?.git_token_set}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium disabled:opacity-50"
                            title={!settings?.git_token_set ? 'Save a PAT first' : 'Push all configs to Git'}
                        >
                            {backing ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <CloudArrowUpIcon className="w-4 h-4" />}
                            {backing ? 'Backing up…' : 'Backup now'}
                        </button>
                        <button
                            onClick={handleRestore}
                            disabled={restoring || !settings?.git_token_set}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-600 text-cyan-700 hover:bg-cyan-50 text-sm font-medium disabled:opacity-50"
                            title={!settings?.git_token_set ? 'Save a PAT first' : 'Create configs missing locally from Git (existing names are skipped)'}
                        >
                            {restoring ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <CloudArrowDownIcon className="w-4 h-4" />}
                            {restoring ? 'Restoring…' : 'Restore from Git'}
                        </button>
                    </div>

                    {msg && (
                        <div className={`text-xs flex items-start gap-1.5 p-2 rounded border ${
                            msg.type === 'ok'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-red-50 border-red-200 text-red-700'
                        }`}>
                            {msg.type === 'ok' ? <CheckCircleIcon className="w-4 h-4 shrink-0" /> : <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />}
                            <span>{msg.text}</span>
                        </div>
                    )}
                </div>
            </section>

            {/* Last backup result */}
            {backupResult && (
                <section className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-[var(--shadow-sm)]">
                    <h3 className="text-sm font-semibold mb-3">Last backup result</h3>
                    <div className="grid grid-cols-4 gap-3 text-center mb-3">
                        <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                            <div className="text-xs text-emerald-600">Created</div>
                            <div className="text-lg font-semibold text-emerald-700">{backupResult.created}</div>
                        </div>
                        <div className="p-2 rounded bg-blue-50 border border-blue-200">
                            <div className="text-xs text-blue-600">Updated</div>
                            <div className="text-lg font-semibold text-blue-700">{backupResult.updated}</div>
                        </div>
                        <div className="p-2 rounded bg-slate-50 border border-slate-200">
                            <div className="text-xs text-slate-600">Unchanged</div>
                            <div className="text-lg font-semibold text-slate-700">{backupResult.unchanged}</div>
                        </div>
                        <div className={`p-2 rounded ${backupResult.failed ? 'bg-red-50 border border-red-200' : 'bg-slate-50 border border-slate-200'}`}>
                            <div className={`text-xs ${backupResult.failed ? 'text-red-600' : 'text-slate-600'}`}>Failed</div>
                            <div className={`text-lg font-semibold ${backupResult.failed ? 'text-red-700' : 'text-slate-700'}`}>{backupResult.failed}</div>
                        </div>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mb-2">
                        Repo: <code>{backupResult.repo}</code> · Branch: <code>{backupResult.branch}</code> · {new Date(backupResult.timestamp).toLocaleString()}
                    </p>
                    <details className="text-xs">
                        <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                            View per-file details ({backupResult.details.length})
                        </summary>
                        <table className="w-full mt-2 text-xs">
                            <thead className="text-[var(--text-muted)]">
                                <tr><th className="text-left py-1">Config</th><th className="text-left">Owner</th><th className="text-left">Status</th><th className="text-left">Error</th></tr>
                            </thead>
                            <tbody>
                                {backupResult.details.map((d, i) => (
                                    <tr key={i} className="border-t border-[var(--border-color)]">
                                        <td className="py-1 font-mono">{d.name}</td>
                                        <td>@{d.owner}</td>
                                        <td className={
                                            d.status === 'failed' ? 'text-red-600' :
                                            d.status === 'created' ? 'text-emerald-600' :
                                            d.status === 'updated' ? 'text-blue-600' : 'text-slate-500'
                                        }>{d.status}</td>
                                        <td className="text-red-500 truncate max-w-xs">{d.error || ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </details>
                </section>
            )}

            {/* Last restore result */}
            {restoreResult && (
                <section className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-[var(--shadow-sm)]">
                    <h3 className="text-sm font-semibold mb-3">Last restore result</h3>
                    <div className="grid grid-cols-3 gap-3 text-center mb-3">
                        <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                            <div className="text-xs text-emerald-600">Restored</div>
                            <div className="text-lg font-semibold text-emerald-700">{restoreResult.restored}</div>
                        </div>
                        <div className="p-2 rounded bg-slate-50 border border-slate-200">
                            <div className="text-xs text-slate-600">Skipped</div>
                            <div className="text-lg font-semibold text-slate-700">{restoreResult.skipped}</div>
                        </div>
                        <div className={`p-2 rounded ${restoreResult.failed ? 'bg-red-50 border border-red-200' : 'bg-slate-50 border border-slate-200'}`}>
                            <div className={`text-xs ${restoreResult.failed ? 'text-red-600' : 'text-slate-600'}`}>Failed</div>
                            <div className={`text-lg font-semibold ${restoreResult.failed ? 'text-red-700' : 'text-slate-700'}`}>{restoreResult.failed}</div>
                        </div>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mb-2">
                        Repo: <code>{restoreResult.repo}</code> · Branch: <code>{restoreResult.branch}</code> · {restoreResult.total} config(s) found in repo
                    </p>
                    {restoreResult.truncated && (
                        <p className="text-xs text-amber-600 flex items-start gap-1.5 mb-2">
                            <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />
                            <span>Repo file listing was truncated by GitHub — some configs may not have been scanned.</span>
                        </p>
                    )}
                    <details className="text-xs">
                        <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                            View per-config details ({restoreResult.details.length})
                        </summary>
                        <table className="w-full mt-2 text-xs">
                            <thead className="text-[var(--text-muted)]">
                                <tr><th className="text-left py-1">Config</th><th className="text-left">Assigned to</th><th className="text-left">Status</th><th className="text-left">Note</th></tr>
                            </thead>
                            <tbody>
                                {restoreResult.details.map((d, i) => (
                                    <tr key={i} className="border-t border-[var(--border-color)]">
                                        <td className="py-1 font-mono">{d.name}</td>
                                        <td>{d.assigned_to ? `@${d.assigned_to}` : '—'}</td>
                                        <td className={
                                            d.status === 'failed' ? 'text-red-600' :
                                            d.status === 'restored' ? 'text-emerald-600' : 'text-slate-500'
                                        }>{d.status}</td>
                                        <td className="text-[var(--text-muted)] truncate max-w-xs">{d.error || d.reason || ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </details>
                </section>
            )}
        </div>
    );
}
