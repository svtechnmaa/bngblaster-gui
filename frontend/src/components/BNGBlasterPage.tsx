/**
 * BNGBlaster Page — Full test management, live monitoring, and reporting.
 *
 * Tabs:
 *  1. Servers   — add / remove BNGBlaster server connections
 *  2. Configs   — create / edit / delete JSON test configs (Monaco editor)
 *  3. Run       — pick server + instance + config, start/stop/kill, live stats & log
 *  4. Reports   — fetch run_report.json, dashboard metrics, download
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Editor from '@monaco-editor/react';
import {
    BoltIcon, PlusIcon, TrashIcon, PlayCircleIcon,
    StopCircleIcon, ExclamationTriangleIcon, DocumentTextIcon,
    ArrowDownTrayIcon, ArrowUpTrayIcon, ServerIcon, Cog6ToothIcon,
    ChartBarIcon, ClipboardDocumentListIcon,
    ArrowPathIcon, CheckCircleIcon, DocumentDuplicateIcon,
    PencilSquareIcon, WrenchScrewdriverIcon, XMarkIcon,
    ArrowsPointingOutIcon, ArrowPathRoundedSquareIcon, ChevronUpIcon,
    PresentationChartLineIcon, ShareIcon,
} from '@heroicons/react/24/outline';
import api from '../services/api';
import ConfigBuilder from './ConfigBuilder';
import DashboardTab from './dashboard/DashboardTab';
import TopologyView from './topology/TopologyView';
import { useAuthStore } from '../store/useAuthStore';
import { useTelemetryStore } from '../store/useTelemetryStore';
import { can, type Role } from '../utils/permissions';

// ── Types ────────────────────────────────────────────────────────────────────

interface BNGServer { id: number; name: string; host: string; port: number; ssh_user?: string; ssh_pass?: string; }
interface BNGConfig  {
    id: number; name: string; description?: string; config_json: any; updated_at?: string;
    is_owner?: boolean; owner_username?: string; user_id?: number; tags?: string[];
}

interface NetIfaceStats  { name: string; 'tx-pps': number; 'rx-pps': number; 'rx-loss-packets-streams': number; }
interface AccIfaceStats  { name: string; 'tx-pps': number; 'rx-pps': number; 'rx-loss-packets-streams': number; 'rx-loss-packets-multicast': number; }
interface StreamStats    { name: string; 'flow-id': number; direction: string; 'session-id': number; 'tx-pps': number; 'tx-bps-l2': number; 'rx-pps': number; 'rx-bps-l2': number; 'rx-loss': number; }

// Rolling history entry for sparklines
interface HistEntry { t: number; txPps: number; rxPps: number; loss: number; }

// ── Tiny sparkline (SVG, no lib) ─────────────────────────────────────────────

function Sparkline({ data, color = '#6366f1', height = 40, width = 200 }: {
    data: number[]; color?: string; height?: number; width?: number;
}) {
    if (data.length < 2) return <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><text x={4} y={height / 2 + 4} fontSize={9} fill="#9ca3af">—</text></svg>;
    const max = Math.max(...data, 1);
    const step = width / (data.length - 1);
    const pts = data.map((v, i) => `${i * step},${height - (v / max) * (height - 4) - 2}`).join(' ');
    return (
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="overflow-visible">
            <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
}

function ResizableEditorBox({ defaultHeight = 320, min = 120, max = 900, children }: {
    defaultHeight?: number; min?: number; max?: number; children: React.ReactNode;
}) {
    const [h, setH] = useState(defaultHeight);
    const startDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = h;
        const onMove = (me: MouseEvent) => setH(Math.max(min, Math.min(max, startH + me.clientY - startY)));
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };
    return (
        <div className="relative border border-[var(--border-color)] rounded-lg overflow-hidden" style={{ height: h }}>
            <div className="w-full h-full">{children}</div>
            <div
                onMouseDown={startDrag}
                className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10 flex items-end justify-end p-1 group"
                title="Drag to resize"
            >
                <svg viewBox="0 0 9 9" className="w-full h-full">
                    <line x1="2" y1="8" x2="8" y2="2" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" className="opacity-40 group-hover:opacity-100 transition-opacity" />
                    <line x1="5" y1="8" x2="8" y2="5" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" className="opacity-40 group-hover:opacity-100 transition-opacity" />
                </svg>
            </div>
        </div>
    );
}

function fmtPps(n: number) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}
function fmtBps(n: number) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kbps`;
    return `${n} bps`;
}

// ── Shared tab button ────────────────────────────────────────────────────────

function Tab({ active, onClick, icon: Icon, label, badge }: { active: boolean; onClick: () => void; icon: any; label: string; badge?: string | number }) {
    return (
        <button
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={`group relative flex flex-1 items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap cursor-pointer
                transition-all duration-200 motion-reduce:transition-none
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
                active
                    ? 'text-white shadow-[var(--shadow-md)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]'
            }`}
            style={active ? { background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--accent-cyan) 100%)' } : undefined}
        >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
            {badge !== undefined && (
                <span className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full font-bold tabular-nums transition-colors ${
                    active
                        ? 'bg-white/25 text-white'
                        : 'bg-[var(--bg-hover)] text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'
                }`}>
                    {badge}
                </span>
            )}
        </button>
    );
}

// ── Default config template ──────────────────────────────────────────────────

const DEFAULT_CONFIG = {
    interfaces: {
        access: [{ interface: "eth1.100", type: "ipoe", address: "10.0.0.1", "address-iter": "0.0.0.1", gateway: "10.0.0.254", ipv6: false, "vlan-mode": "N:1", "stream-group-id": 400 }],
        network: [{ interface: "eth0", address: "192.168.1.0/24", gateway: "192.168.1.1", "gateway-resolve-wait": true }],
    },
    sessions: { count: 100 },
    traffic: { "stream-rate-calculation": true, "stream-delay-calculation": true },
};

// ── Main component ───────────────────────────────────────────────────────────

export default function BNGBlasterPage() {
    const [tab, setTab] = useState<'dashboard' | 'servers' | 'configs' | 'run' | 'reports'>('dashboard');
    const [topologyModalCfg, setTopologyModalCfg] = useState<BNGConfig | null>(null);
    const [topologyCfgId, setTopologyCfgId] = useState<number | null>(null);

    // ── Current user role ────────────────────────────────────────────────
    const { user } = useAuthStore();
    const role = (user?.role ?? 'viewer') as Role;

    // ── Servers state ───────────────────────────────────────────────────
    const [servers, setServers] = useState<BNGServer[]>([]);
    const [svrHost, setSvrHost] = useState('');
    const [svrPort, setSvrPort] = useState('8001');
    const [svrName, setSvrName] = useState('');
    const [svrSshUser, setSvrSshUser] = useState('');
    const [svrSshPass, setSvrSshPass] = useState('');
    const [svrSaving, setSvrSaving] = useState(false);

    // edit-server state
    const [editingServer, setEditingServer] = useState<BNGServer | null>(null);
    const [editSvrName, setEditSvrName] = useState('');
    const [editSvrHost, setEditSvrHost] = useState('');
    const [editSvrPort, setEditSvrPort] = useState('8001');
    const [editSvrSshUser, setEditSvrSshUser] = useState('');
    const [editSvrSshPass, setEditSvrSshPass] = useState('');
    const [editSvrSaving, setEditSvrSaving] = useState(false);

    // cleanup-interfaces state
    const [cleanupServer, setCleanupServer] = useState<BNGServer | null>(null);
    const [cleanupIfaces, setCleanupIfaces] = useState<string[]>([]);
    const [selectedCleanupIfaces, setSelectedCleanupIfaces] = useState<Set<string>>(new Set());
    const [cleanupListLoading, setCleanupListLoading] = useState(false);
    const [cleanupExeLoading, setCleanupExeLoading] = useState(false);
    const [cleanupResult, setCleanupResult] = useState<{ success: boolean; msg: string; stderr?: string; stdout?: string } | null>(null);

    // ── Shared VLAN observer (visible across all tabs) ───────────────────
    const [vlanIfaces, setVlanIfaces]           = useState<string[]>([]);
    const [vlanIfacesLoading, setVlanIfacesLoading] = useState(false);
    const [vlanIfacesError, setVlanIfacesError] = useState('');
    const [vlanPanelOpen, setVlanPanelOpen]     = useState(true);

    // ── Configs state ───────────────────────────────────────────────────
    const [cfgSubTab, setCfgSubTab] = useState<'editor' | 'builder'>('editor');
    const [savedCfgSearch, setSavedCfgSearch] = useState('');
    const [savedCfgFilter, setSavedCfgFilter] = useState<'all' | 'running' | 'idle'>('all');
    const [configs, setConfigs] = useState<BNGConfig[]>([]);
    const [editingCfg, setEditingCfg] = useState<BNGConfig | null>(null);
    const [selectedCfgIds, setSelectedCfgIds] = useState<Set<number>>(new Set());
    const [cfgName, setCfgName] = useState('');
    const [cfgDesc, setCfgDesc] = useState('');
    const [cfgTags, setCfgTags] = useState<string[]>([]);
    const [cfgTagInput, setCfgTagInput] = useState('');
    const [cfgJson, setCfgJson] = useState(JSON.stringify(DEFAULT_CONFIG, null, 2));
    const [cfgSaving, setCfgSaving] = useState(false);
    const [cfgError, setCfgError] = useState('');

    // ── Run state ────────────────────────────────────────────────────────
    const [selServer, setSelServer] = useState<BNGServer | null>(null);
    const [allInstances, setAllInstances] = useState<{ name: string; status: string }[]>([]);
    const [runMsg, setRunMsg] = useState('');
    const [runError, setRunError] = useState('');
    const [loadingInstances, setLoadingInstances] = useState(false);
    // per-instance action loading: { 'inst-name:stop': true }
    const [instActionLoading, setInstActionLoading] = useState<Record<string, boolean>>({});
    const [instFilter, setInstFilter] = useState<'all' | 'running'>('running');
    const [instSearch, setInstSearch] = useState('');
    const [cfgRunSearch, setCfgRunSearch] = useState('');
    const [cfgRunFilter, setCfgRunFilter] = useState<'all' | 'running' | 'idle'>('all');

    // live monitoring — driven by refs so pollStats closure never goes stale
    const [activeMonitorInstance, setActiveMonitorInstance] = useState<string | null>(null);
    const activeMonitorInstanceRef = useRef<string | null>(null);
    const activeMonitorServerRef   = useRef<BNGServer | null>(null);
    const [monitoring, setMonitoring] = useState(false);
    const monitorRef     = useRef(false);
    const pollTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [netStats, setNetStats]       = useState<NetIfaceStats[]>([]);
    const [accStats, setAccStats]       = useState<AccIfaceStats[]>([]);
    const [streamStats, setStreamStats] = useState<StreamStats[]>([]);
    const netHistRef = useRef<Record<string, HistEntry[]>>({});
    const accHistRef = useRef<Record<string, HistEntry[]>>({});

    // stream flow selection (ref so pollStats closure always reads latest)
    const [monitorTotalFlows, setMonitorTotalFlows] = useState(0);
    const [selectedFlowIds, setSelectedFlowIds]     = useState<number[]>([]);
    const selectedFlowIdsRef                        = useRef<number[]>([]);
    const [flowIdInput, setFlowIdInput]             = useState('');

    // log panel (tied to monitored instance)
    const [logText, setLogText]     = useState('');
    const [logLoading, setLogLoading] = useState(false);
    const logPreRef = useRef<HTMLPreElement>(null);

    // instance config viewer (top section)
    const [viewConfigInstance, setViewConfigInstance] = useState<string | null>(null);
    const [viewConfigJson, setViewConfigJson]         = useState('');
    const [viewConfigLoading, setViewConfigLoading]   = useState(false);

    // saved-config start (bottom section)
    const [startingConfigId, setStartingConfigId] = useState<number | null>(null);
    const [viewingCfgId, setViewingCfgId]         = useState<number | null>(null);
    const [ifaceSetupLog, setIfaceSetupLog]        = useState<{ ifaces: string[]; ok: boolean; msg: string; stdout?: string; stderr?: string; exitCode?: number } | null>(null);

    // ── Reports state ────────────────────────────────────────────────────
    const [rptServer, setRptServer] = useState<BNGServer | null>(null);
    const [rptInstances, setRptInstances] = useState<string[]>([]);
    const [rptInstance, setRptInstance] = useState('');
    const [report, setReport] = useState<any>(null);
    const [rptLoading, setRptLoading] = useState(false);
    const [rptError, setRptError] = useState('');

    // ── Table fullscreen / download ──────────────────────────────────────
    const [fullscreenTable, setFullscreenTable] = useState<'network' | 'access' | 'stream' | null>(null);

    // ── Restart ───────────────────────────────────────────────────────────
    const [restartingInstance, setRestartingInstance] = useState<string | null>(null);

    // ── Error banner ─────────────────────────────────────────────────────
    const [globalError, setGlobalError] = useState('');

    // ── Default SSH credentials (saved in DB, managed in Servers tab) ────
    const [defaultSshUser, setDefaultSshUser] = useState('');
    const [defaultSshPass, setDefaultSshPass] = useState('');
    const [credsSaving, setCredsSaving] = useState(false);
    const [credsSaved, setCredsSaved]   = useState(false);
    const [showCredPass, setShowCredPass] = useState(false);

    // ── Publish live telemetry to the TopBar instrument rail ──────────────
    const setTelemetry = useTelemetryStore(s => s.setTelemetry);
    const resetTelemetry = useTelemetryStore(s => s.reset);
    useEffect(() => {
        const running = allInstances.filter(i => i.status === 'started').length;
        const hasLive = monitoring && netStats.length > 0;
        const txPps = hasLive ? netStats.reduce((a, i) => a + (i['tx-pps'] || 0), 0) : 0;
        const rxPps = hasLive ? netStats.reduce((a, i) => a + (i['rx-pps'] || 0), 0) : 0;
        const txBps = hasLive ? streamStats.reduce((a, s) => a + (s['tx-bps-l2'] || 0), 0) : 0;
        const rxBps = hasLive ? streamStats.reduce((a, s) => a + (s['rx-bps-l2'] || 0), 0) : 0;
        const loss = hasLive ? streamStats.reduce((a, s) => a + (s['rx-loss'] || 0), 0) : 0;
        setTelemetry({
            server: selServer ? { name: selServer.name, host: selServer.host, port: selServer.port } : null,
            total: allInstances.length, running, monitoring,
            txPps, rxPps, txBps, rxBps, loss, streams: streamStats.length, hasLive,
        });
    }, [selServer, allInstances, monitoring, netStats, streamStats, setTelemetry]);
    useEffect(() => () => resetTelemetry(), [resetTelemetry]);

    // ── Load servers + configs + settings on mount ────────────────────────
    useEffect(() => {
        api.get('/bngblaster/servers').then(r => {
            const list = r.data as BNGServer[];
            setServers(list);
            if (list.length > 0) {
                setSelServer(list[0]);
                loadInstances(list[0]);
            }
        }).catch(() => { });
        api.get('/bngblaster/configs').then(r => setConfigs(r.data)).catch(() => { });
        // Load default SSH credentials from app settings
        api.get('/settings').then(r => {
            const u = r.data.bng_ssh_user || '';
            const p = r.data.bng_ssh_pass || '';
            setDefaultSshUser(u);
            setDefaultSshPass(p);
            setSvrSshUser(u);
            setSvrSshPass(p);
        }).catch(() => { });
    }, []);

    const handleSaveCreds = async () => {
        setCredsSaving(true);
        try {
            await api.put('/settings', { bng_ssh_user: defaultSshUser, bng_ssh_pass: defaultSshPass });
            setSvrSshUser(defaultSshUser);
            setSvrSshPass(defaultSshPass);
            setCredsSaved(true);
            setTimeout(() => setCredsSaved(false), 2000);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Failed to save credentials'); }
        finally { setCredsSaving(false); }
    };

    // ── Helpers ───────────────────────────────────────────────────────────

    const showErr = (msg: string) => { setGlobalError(msg); setTimeout(() => setGlobalError(''), 5000); };

    // ── Servers CRUD ──────────────────────────────────────────────────────

    const handleAddServer = async () => {
        if (!svrHost.trim()) return;
        setSvrSaving(true);
        try {
            const r = await api.post('/bngblaster/servers', { name: svrName || svrHost, host: svrHost, port: parseInt(svrPort) || 8001, ssh_user: svrSshUser || null, ssh_pass: svrSshPass || null });
            setServers(s => [r.data, ...s]);
            // Reset form — keep SSH defaults from Settings
            setSvrHost(''); setSvrPort('8001'); setSvrName('');
            setSvrSshUser(defaultSshUser); setSvrSshPass(defaultSshPass);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Failed to add server'); }
        finally { setSvrSaving(false); }
    };

    const handleDeleteServer = async (id: number) => {
        if (!confirm('Delete this server?')) return;
        try {
            await api.delete(`/bngblaster/servers/${id}`);
            setServers(s => s.filter(x => x.id !== id));
            if (selServer?.id === id) setSelServer(null);
            if (rptServer?.id === id) setRptServer(null);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Delete failed'); }
    };

    const handleEditServer = (s: BNGServer) => {
        setEditingServer(s);
        setEditSvrName(s.name);
        setEditSvrHost(s.host);
        setEditSvrPort(String(s.port));
        setEditSvrSshUser(s.ssh_user || '');
        setEditSvrSshPass(s.ssh_pass || '');
    };

    const handleUpdateServer = async () => {
        if (!editingServer || !editSvrHost.trim()) return;
        setEditSvrSaving(true);
        try {
            const r = await api.put(`/bngblaster/servers/${editingServer.id}`, {
                name: editSvrName || editSvrHost,
                host: editSvrHost,
                port: parseInt(editSvrPort) || 8001,
                ssh_user: editSvrSshUser || null,
                ssh_pass: editSvrSshPass || null,
            });
            setServers(ss => ss.map(s => s.id === editingServer.id ? r.data : s));
            if (selServer?.id === editingServer.id) setSelServer(r.data);
            setEditingServer(null);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Update failed'); }
        finally { setEditSvrSaving(false); }
    };

    const handleOpenCleanup = async (s: BNGServer) => {
        setCleanupServer(s);
        setCleanupIfaces([]);
        setSelectedCleanupIfaces(new Set());
        setCleanupResult(null);
        setCleanupListLoading(true);
        try {
            const r = await api.post(`/bngblaster/servers/${s.id}/ssh-list-vlan-interfaces`);
            setCleanupIfaces(r.data.interfaces || []);
        } catch (e: any) { showErr(e.response?.data?.detail || 'SSH connection failed'); setCleanupServer(null); }
        finally { setCleanupListLoading(false); }
    };

    const handleCleanupIfaces = async () => {
        if (!cleanupServer || selectedCleanupIfaces.size === 0) return;
        setCleanupExeLoading(true);
        try {
            const r = await api.post(`/bngblaster/servers/${cleanupServer.id}/cleanup-interfaces`, {
                interfaces: Array.from(selectedCleanupIfaces),
            });
            const d = r.data;
            const cleaned: string[] = d.cleaned || [];
            const failed: string[]  = d.failed  || [];
            const parts: string[] = [];
            if (cleaned.length > 0) parts.push(`Deleted: ${cleaned.join(', ')}`);
            if (failed.length > 0)  parts.push(`Failed: ${failed.join(', ')}`);
            const msg = parts.join(' | ') || d.stderr || d.stdout || 'No output';
            setCleanupResult({ success: d.success, msg, stderr: d.stderr, stdout: d.stdout });
            // Refresh both the cleanup list and the shared VLAN observer panel
            const r2 = await api.post(`/bngblaster/servers/${cleanupServer.id}/ssh-list-vlan-interfaces`);
            const refreshed = r2.data.interfaces || [];
            setCleanupIfaces(refreshed);
            setVlanIfaces(refreshed);
            setSelectedCleanupIfaces(new Set());
        } catch (e: any) { showErr(e.response?.data?.detail || 'Cleanup failed'); }
        finally { setCleanupExeLoading(false); }
    };

    // ── Shared VLAN observer helpers ──────────────────────────────────────

    const fetchVlanIfaces = useCallback(async (server: BNGServer) => {
        setVlanIfacesLoading(true);
        setVlanIfacesError('');
        try {
            const r = await api.post(`/bngblaster/servers/${server.id}/ssh-list-vlan-interfaces`);
            setVlanIfaces(r.data.interfaces || []);
        } catch (e: any) {
            setVlanIfacesError(e.response?.data?.detail || 'SSH connection failed');
            setVlanIfaces([]);
        } finally {
            setVlanIfacesLoading(false);
        }
    }, []);

    // Auto-fetch when server selection changes
    useEffect(() => {
        if (selServer) {
            setVlanIfaces([]);
            setVlanIfacesError('');
            fetchVlanIfaces(selServer);
        } else {
            setVlanIfaces([]);
            setVlanIfacesError('');
        }
    }, [selServer, fetchVlanIfaces]);

    // ── Configs CRUD ──────────────────────────────────────────────────────

    const startNewConfig = () => {
        setEditingCfg(null);
        setCfgName(''); setCfgDesc('');
        setCfgTags([]); setCfgTagInput('');
        setCfgJson(JSON.stringify(DEFAULT_CONFIG, null, 2));
        setCfgError('');
    };

    const startEditConfig = (c: BNGConfig) => {
        setEditingCfg(c);
        setCfgName(c.name); setCfgDesc(c.description || '');
        setCfgTags(c.tags ?? []); setCfgTagInput('');
        setCfgJson(JSON.stringify(c.config_json, null, 2));
        setCfgError('');
    };

    // Returns the conflicting config (owned by anyone) if `cfgName` collides with another config
    // than the one currently being edited, else null.
    const nameConflict = (() => {
        const trimmed = cfgName.trim();
        if (!trimmed) return null;
        return configs.find(c => c.name === trimmed && c.id !== editingCfg?.id) ?? null;
    })();

    const addCfgTag = (raw: string) => {
        const t = raw.trim().slice(0, 30).trim();
        if (!t) return;
        setCfgTags(prev => prev.some(x => x.toLowerCase() === t.toLowerCase()) || prev.length >= 10 ? prev : [...prev, t]);
        setCfgTagInput('');
    };

    const handleSaveConfig = async () => {
        if (!cfgName.trim()) { setCfgError('Name is required'); return; }
        if (nameConflict) {
            setCfgError(
                `Name "${nameConflict.name}" is already used${nameConflict.owner_username ? ` by @${nameConflict.owner_username}` : ''}. Choose a different name.`
            );
            return;
        }
        let parsed: any;
        try { parsed = JSON.parse(cfgJson); } catch { setCfgError('Invalid JSON'); return; }
        setCfgSaving(true); setCfgError('');
        try {
            if (editingCfg) {
                const r = await api.put(`/bngblaster/configs/${editingCfg.id}`, { name: cfgName.trim(), description: cfgDesc, tags: cfgTags, config_json: parsed });
                setConfigs(cs => cs.map(c => c.id === editingCfg.id ? r.data : c));
            } else {
                const r = await api.post('/bngblaster/configs', { name: cfgName.trim(), description: cfgDesc, tags: cfgTags, config_json: parsed });
                setConfigs(cs => [r.data, ...cs]);
            }
            startNewConfig();
        } catch (e: any) { setCfgError(e.response?.data?.detail || 'Save failed'); }
        finally { setCfgSaving(false); }
    };

    const handleDeleteConfig = async (id: number) => {
        if (!confirm('Delete this config?')) return;
        try {
            await api.delete(`/bngblaster/configs/${id}`);
            setConfigs(cs => cs.filter(c => c.id !== id));
            if (editingCfg?.id === id) startNewConfig();
        } catch (e: any) { showErr(e.response?.data?.detail || 'Delete failed'); }
    };

    const handleCloneConfig = async (c: BNGConfig) => {
        try {
            // Use dedicated clone endpoint — available to all users including viewers
            const r = await api.post(`/bngblaster/configs/${c.id}/clone`);
            setConfigs(cs => [r.data, ...cs]);
            // Open clone in editor so user can rename immediately
            startEditConfig(r.data);
            setTab('configs');
            setCfgSubTab('editor');
        } catch (e: any) { showErr(e.response?.data?.detail || 'Clone failed'); }
    };

    // ── Download / Import helpers ─────────────────────────────────────────
    const triggerBrowserDownload = (filename: string, content: string) => {
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    };

    // Download a single config as raw BNGBlaster-compatible JSON
    const handleDownloadConfig = (c: BNGConfig) => {
        const filename = `${c.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
        triggerBrowserDownload(filename, JSON.stringify(c.config_json ?? {}, null, 2));
    };

    // Export all configs as a single wrapped-array file (for re-import / backup)
    const handleExportAllConfigs = () => {
        if (configs.length === 0) { showErr('No configs to export'); return; }
        const payload = {
            exported_at: new Date().toISOString(),
            format: 'bng-configs-v1',
            configs: configs.map(c => ({
                name: c.name,
                description: c.description ?? '',
                config_json: c.config_json,
            })),
        };
        const stamp = new Date().toISOString().slice(0, 10);
        triggerBrowserDownload(`bng-configs-${stamp}.json`, JSON.stringify(payload, null, 2));
    };

    // ── Bulk selection actions (multi-select in Saved Configs) ────────────────
    const toggleCfgSelected = (id: number) => {
        setSelectedCfgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const clearCfgSelection = () => setSelectedCfgIds(new Set());

    // Download each selected config as its own raw .json file
    const handleBulkDownload = () => {
        const chosen = configs.filter(c => selectedCfgIds.has(c.id));
        if (chosen.length === 0) return;
        chosen.forEach(handleDownloadConfig);
    };

    // Delete every selected config the current user is allowed to delete
    const handleBulkDelete = async () => {
        const chosen = configs.filter(c => selectedCfgIds.has(c.id));
        const deletable = chosen.filter(c => can.deleteBNGConfig(role, c.is_owner !== false));
        if (deletable.length === 0) { showErr('You have no permission to delete the selected configs'); return; }
        const skipped = chosen.length - deletable.length;
        const prompt = `Delete ${deletable.length} config(s)?` + (skipped ? ` (${skipped} skipped — no permission)` : '');
        if (!confirm(prompt)) return;
        const ids = deletable.map(c => c.id);
        const results = await Promise.allSettled(ids.map(id => api.delete(`/bngblaster/configs/${id}`)));
        const okIds = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'));
        const failed = results.length - okIds.size;
        setConfigs(cs => cs.filter(c => !okIds.has(c.id)));
        if (editingCfg && okIds.has(editingCfg.id)) startNewConfig();
        clearCfgSelection();
        if (failed) showErr(`${failed} config(s) failed to delete`);
    };

    const importFileInputRef = useRef<HTMLInputElement | null>(null);

    // Post a config, retrying with ` (imported)`, ` (imported 2)`, ... on 409 name conflict.
    const postConfigWithRename = async (base: { name: string; description?: string; config_json: unknown }) => {
        const originalName = base.name;
        for (let attempt = 0; attempt < 50; attempt++) {
            const candidate = attempt === 0
                ? originalName
                : attempt === 1
                    ? `${originalName} (imported)`
                    : `${originalName} (imported ${attempt})`;
            try {
                const r = await api.post('/bngblaster/configs', { ...base, name: candidate });
                return { ok: true as const, data: r.data, renamed: candidate !== originalName };
            } catch (e: any) {
                if (e?.response?.status !== 409) {
                    return { ok: false as const, error: e?.response?.data?.detail || 'Save failed' };
                }
                // 409 → try next suffix
            }
        }
        return { ok: false as const, error: 'Too many name conflicts' };
    };

    const handleImportFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        let imported = 0, renamed = 0, failed = 0;
        for (const file of Array.from(files)) {
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);

                // Detect format: bulk export wrapper, or single raw config
                const items: { name: string; description?: string; config_json: unknown }[] = [];
                if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).configs)) {
                    // Bulk wrapper
                    for (const entry of (parsed as any).configs) {
                        if (entry && typeof entry === 'object' && entry.name && entry.config_json) {
                            items.push({ name: entry.name, description: entry.description, config_json: entry.config_json });
                        }
                    }
                } else {
                    // Treat as a single raw config_json — derive name from filename
                    const base = file.name.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9 ._-]/g, '_');
                    items.push({ name: base || 'imported-config', description: 'Imported from file', config_json: parsed });
                }

                for (const item of items) {
                    const res = await postConfigWithRename(item);
                    if (res.ok) {
                        setConfigs(cs => [res.data, ...cs]);
                        imported++;
                        if (res.renamed) renamed++;
                    } else {
                        failed++;
                    }
                }
            } catch { failed++; }
        }
        if (imported) {
            const parts: string[] = [`Imported ${imported} config${imported > 1 ? 's' : ''}`];
            if (renamed) parts.push(`${renamed} auto-renamed (name conflict)`);
            if (failed) parts.push(`${failed} failed`);
            setRunMsg(parts.join(' · '));
        } else if (failed) {
            showErr(`Import failed (${failed} file${failed > 1 ? 's' : ''})`);
        }
        setTimeout(() => setRunMsg(''), 5000);
    };

    // ── Run tab helpers ───────────────────────────────────────────────────

    // Sanitise config name → valid BNGBlaster instance name
    const toInstanceName = (name: string) =>
        name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'instance';

    // True if current user may stop/kill/restart this instance:
    // admin can control all; others only if they own the matching config.
    const canControlInstance = (instanceName: string): boolean => {
        if (role === 'admin') return true;
        return configs.some(c => toInstanceName(c.name) === instanceName && c.is_owner !== false);
    };

    // Returns owner_username from the matching config, or null if current user owns it / unknown.
    const getInstanceOwner = (instanceName: string): string | null => {
        const cfg = configs.find(c => toInstanceName(c.name) === instanceName);
        if (!cfg || cfg.is_owner !== false) return null;
        return cfg.owner_username ?? null;
    };

    const setInstLoading = (inst: string, action: string, on: boolean) =>
        setInstActionLoading(prev => { const n = { ...prev }; if (on) n[`${inst}:${action}`] = true; else delete n[`${inst}:${action}`]; return n; });

    const loadInstances = useCallback(async (server: BNGServer) => {
        setLoadingInstances(true);
        setAllInstances([]);
        try {
            // Single request — backend fetches all statuses in parallel via asyncio.gather
            const r = await api.get(`/bngblaster/servers/${server.id}/instances-with-status`);
            setAllInstances(Array.isArray(r.data) ? r.data : []);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Failed to load instances'); }
        finally { setLoadingInstances(false); }
    }, []);

    const handleStop = async (instance: string) => {
        if (!selServer) return;
        setInstLoading(instance, 'stop', true);
        try {
            await api.post(`/bngblaster/servers/${selServer.id}/instances/${instance}/stop`);
            setRunMsg(`"${instance}" stopped`); setTimeout(() => setRunMsg(''), 3000);
            if (activeMonitorInstanceRef.current === instance) stopMonitoring();
            await loadInstances(selServer);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Stop failed'); }
        finally { setInstLoading(instance, 'stop', false); }
    };

    const handleKill = async (instance: string) => {
        if (!selServer) return;
        if (!confirm(`Force-kill "${instance}"? The report may not be generated.`)) return;
        setInstLoading(instance, 'kill', true);
        try {
            await api.post(`/bngblaster/servers/${selServer.id}/instances/${instance}/kill`);
            setRunMsg(`"${instance}" killed`); setTimeout(() => setRunMsg(''), 3000);
            if (activeMonitorInstanceRef.current === instance) stopMonitoring();
            await loadInstances(selServer);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Kill failed'); }
        finally { setInstLoading(instance, 'kill', false); }
    };

    const handleRestart = async (instance: string) => {
        if (!selServer) return;
        setRestartingInstance(instance);
        setInstLoading(instance, 'restart', true);
        try {
            // 1. Save current config before stopping
            const cfgR = await api.get(`/bngblaster/servers/${selServer.id}/instances/${instance}/config`);
            const configJson = cfgR.data;
            // 2. Stop the instance
            await api.post(`/bngblaster/servers/${selServer.id}/instances/${instance}/stop`);
            // 3. Poll until stopped (max 60s)
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                const st = await api.get(`/bngblaster/servers/${selServer.id}/instances/${instance}/status`);
                if (st.data?.status === 'stopped') break;
            }
            // 4. Start again with saved config
            await api.post(`/bngblaster/servers/${selServer.id}/instances/${instance}/_start`, { config_json: configJson });
            setRunMsg(`"${instance}" restarted`); setTimeout(() => setRunMsg(''), 4000);
            await loadInstances(selServer);
            startMonitoringFor(selServer, instance);
        } catch (e: any) { showErr(e.response?.data?.detail || 'Restart failed'); }
        finally { setRestartingInstance(null); setInstLoading(instance, 'restart', false); }
    };

    /** Export any array of objects to a CSV download */
    const downloadCsv = (rows: any[], filename: string, cols: { key: string; label: string }[]) => {
        const header = cols.map(c => `"${c.label}"`).join(',');
        const body = rows.map(r =>
            cols.map(c => `"${String(r[c.key] ?? '').replace(/"/g, '""')}"`).join(',')
        ).join('\n');
        const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
        a.click(); URL.revokeObjectURL(a.href);
    };

    const handleViewInstanceConfig = async (instance: string) => {
        if (viewConfigInstance === instance) { setViewConfigInstance(null); return; }
        if (!selServer) return;
        setViewConfigInstance(instance);
        setViewConfigLoading(true);
        try {
            const r = await api.get(`/bngblaster/servers/${selServer.id}/instances/${instance}/config`);
            setViewConfigJson(JSON.stringify(r.data, null, 2));
        } catch (e: any) { setViewConfigJson(`// Error: ${e.response?.data?.detail || e.message}`); }
        finally { setViewConfigLoading(false); }
    };

    const handleStartFromConfig = async (c: BNGConfig) => {
        if (!selServer) { showErr('Select a BNG server first'); return; }
        const instName = toInstanceName(c.name);
        setStartingConfigId(c.id); setRunError(''); setIfaceSetupLog(null);
        try {
            // Step 1: Setup VLAN subinterfaces via SSH (if server has SSH credentials)
            if (selServer.ssh_user && selServer.ssh_pass) {
                try {
                    const sr = await api.post(`/bngblaster/servers/${selServer.id}/setup-interfaces`, { config_json: c.config_json });
                    const d = sr.data;
                    const ifaces: string[] = d.interfaces ?? [];
                    if (ifaces.length === 0) {
                        setIfaceSetupLog({ ifaces, ok: true, msg: 'No VLAN interfaces needed' });
                    } else if (d.success) {
                        setIfaceSetupLog({ ifaces, ok: true, msg: `OK: ${ifaces.join(', ')}`, stdout: d.stdout, stderr: d.stderr, exitCode: d.exit_code });
                    } else {
                        setIfaceSetupLog({ ifaces, ok: false, msg: `Failed (exit ${d.exit_code}): ${d.stderr || d.stdout || 'unknown error'}`, stdout: d.stdout, stderr: d.stderr, exitCode: d.exit_code });
                    }
                } catch (se: any) {
                    const msg = se.response?.data?.detail || 'SSH connection failed';
                    setIfaceSetupLog({ ifaces: [], ok: false, msg });
                    // Continue starting even if SSH setup fails — user sees the warning
                }
            }
            // Step 2: Push config + start instance
            await api.post(
                `/bngblaster/servers/${selServer.id}/instances/${instName}/_start`,
                { config_json: c.config_json },
            );
            setRunMsg(`Instance "${instName}" started`); setTimeout(() => setRunMsg(''), 4000);
            await loadInstances(selServer);
            // Auto-open monitor for the newly started instance
            startMonitoringFor(selServer, instName);
        } catch (e: any) { setRunError(e.response?.data?.detail || 'Start failed'); }
        finally { setStartingConfigId(null); }
    };

    const fetchLog = async (instance: string) => {
        if (!selServer) return;
        setLogLoading(true);
        try {
            const r = await api.get(`/bngblaster/servers/${selServer.id}/instances/${instance}/log`);
            setLogText(r.data.log || '(empty log)');
        } catch (e: any) { setLogText(`Error: ${e.response?.data?.detail || e.message}`); }
        finally { setLogLoading(false); }
    };

    // ── Live monitoring ───────────────────────────────────────────────────
    // Use refs so pollStats closure never reads stale React state

    const pollStats = useCallback(async () => {
        const server   = activeMonitorServerRef.current;
        const instance = activeMonitorInstanceRef.current;
        if (!server || !instance || !monitorRef.current) return;
        try {
            const [netR, accR, stmR] = await Promise.allSettled([
                api.post(`/bngblaster/servers/${server.id}/instances/${instance}/command`, { command: 'network-interfaces' }),
                api.post(`/bngblaster/servers/${server.id}/instances/${instance}/command`, { command: 'access-interfaces' }),
                api.post(`/bngblaster/servers/${server.id}/instances/${instance}/command`, { command: 'stream-stats' }),
            ]);
            if (netR.status === 'fulfilled') {
                const ifaces: NetIfaceStats[] = netR.value.data?.['network-interfaces'] || [];
                setNetStats(ifaces);
                const now = Date.now();
                ifaces.forEach(iface => {
                    const hist = netHistRef.current[iface.name] || [];
                    hist.push({ t: now, txPps: iface['tx-pps'] || 0, rxPps: iface['rx-pps'] || 0, loss: iface['rx-loss-packets-streams'] || 0 });
                    if (hist.length > 60) hist.shift();
                    netHistRef.current[iface.name] = hist;
                });
            }
            if (accR.status === 'fulfilled') {
                const ifaces: AccIfaceStats[] = accR.value.data?.['access-interfaces'] || [];
                setAccStats(ifaces);
                const now = Date.now();
                ifaces.forEach(iface => {
                    const hist = accHistRef.current[iface.name] || [];
                    hist.push({ t: now, txPps: iface['tx-pps'] || 0, rxPps: iface['rx-pps'] || 0, loss: iface['rx-loss-packets-streams'] || 0 });
                    if (hist.length > 60) hist.shift();
                    accHistRef.current[iface.name] = hist;
                });
            }
            if (stmR.status === 'fulfilled') {
                const totalFlows: number = stmR.value.data?.['stream-stats']?.['total-flows'] || 0;
                setMonitorTotalFlows(totalFlows);
                // Only fetch flows the user has explicitly selected
                const toFetch = selectedFlowIdsRef.current.filter(id => id >= 1 && id <= totalFlows);
                if (toFetch.length > 0) {
                    const flowResults = await Promise.allSettled(
                        toFetch.map(fid =>
                            api.post(`/bngblaster/servers/${server.id}/instances/${instance}/command`, {
                                command: 'stream-info',
                                arguments: { 'flow-id': fid },
                            })
                        )
                    );
                    const streamResults: StreamStats[] = flowResults
                        .filter(r => r.status === 'fulfilled')
                        .map(r => (r as PromiseFulfilledResult<any>).value.data?.['stream-info'])
                        .filter(Boolean);
                    setStreamStats(streamResults);
                } else {
                    setStreamStats([]);
                }
            }
        } catch { /* ignore poll errors */ }
        if (monitorRef.current) pollTimerRef.current = setTimeout(pollStats, 2000);
    }, []); // no deps — reads from refs

    const startMonitoringFor = useCallback((server: BNGServer, instance: string) => {
        activeMonitorServerRef.current   = server;
        activeMonitorInstanceRef.current = instance;
        setActiveMonitorInstance(instance);
        monitorRef.current = true;
        setMonitoring(true);
        setNetStats([]); setAccStats([]); setStreamStats([]);
        setMonitorTotalFlows(0);
        selectedFlowIdsRef.current = []; setSelectedFlowIds([]); setFlowIdInput('');
        setLogText('');
        netHistRef.current = {};
        accHistRef.current = {};
        pollStats();
    }, [pollStats]);

    const stopMonitoring = useCallback(() => {
        monitorRef.current = false;
        setMonitoring(false);
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    }, []);

    const toggleMonitor = (instance: string) => {
        if (!selServer) return;
        if (activeMonitorInstance === instance && monitoring) {
            stopMonitoring();
            setActiveMonitorInstance(null);
            activeMonitorInstanceRef.current = null;
        } else {
            startMonitoringFor(selServer, instance);
        }
    };

    useEffect(() => () => stopMonitoring(), [stopMonitoring]);

    // Auto-scroll log to bottom whenever new log content is loaded
    useEffect(() => {
        if (logPreRef.current && logText) {
            logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
        }
    }, [logText]);

    // ── Stream flow selection helpers ─────────────────────────────────────

    /** Parse "1,2,5-10,15" → [1,2,5,6,7,8,9,10,15] */
    const parseFlowIds = (input: string): number[] => {
        const ids = new Set<number>();
        for (const part of input.split(',')) {
            const trimmed = part.trim();
            const range = trimmed.match(/^(\d+)-(\d+)$/);
            if (range) {
                const lo = parseInt(range[1]), hi = parseInt(range[2]);
                for (let i = lo; i <= Math.min(hi, lo + 9999); i++) ids.add(i);
            } else {
                const n = parseInt(trimmed);
                if (!isNaN(n) && n > 0) ids.add(n);
            }
        }
        return Array.from(ids).sort((a, b) => a - b);
    };

    const applyFlowIds = (ids: number[]) => {
        selectedFlowIdsRef.current = ids;
        setSelectedFlowIds(ids);
    };

    const handleApplyFlowInput = () => applyFlowIds(parseFlowIds(flowIdInput));

    const handleSelectAllFlows = () => {
        const limit = Math.min(monitorTotalFlows, 500);
        const ids = Array.from({ length: limit }, (_, i) => i + 1);
        applyFlowIds(ids);
        setFlowIdInput(limit < monitorTotalFlows ? `1-${limit}` : `1-${limit}`);
    };

    const handleClearFlows = () => {
        applyFlowIds([]);
        setFlowIdInput('');
        setStreamStats([]);
    };

    // ── Reports tab ───────────────────────────────────────────────────────

    const loadRptInstances = async (server: BNGServer) => {
        setRptServer(server); setRptInstances([]); setRptInstance(''); setReport(null); setRptError('');
        try {
            const r = await api.get(`/bngblaster/servers/${server.id}/instances`);
            const data = r.data;
            const all = [...new Set([
                ...(Array.isArray(data?.['running-instances']) ? data['running-instances'] : []),
                ...(Array.isArray(data?.instances) ? data.instances : []),
            ])] as string[];
            setRptInstances(all);
        } catch (e: any) { setRptError(e.response?.data?.detail || 'Failed to load instances'); }
    };

    const fetchReport = async () => {
        if (!rptServer || !rptInstance) return;
        setRptLoading(true); setRptError(''); setReport(null);
        try {
            const r = await api.get(`/bngblaster/servers/${rptServer.id}/instances/${rptInstance}/report`);
            setReport(r.data);
        } catch (e: any) { setRptError(e.response?.data?.detail || 'No report available'); }
        finally { setRptLoading(false); }
    };

    const downloadReport = () => {
        if (!report) return;
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(blob),
            download: `${rptInstance}_report.json`,
        });
        a.click();
    };

    // ── Status badge ──────────────────────────────────────────────────────
    const StatusBadge = ({ status }: { status: string }) => {
        const cls = status === 'started' || status === 'running'
            ? 'bg-green-100 text-green-700'
            : status === 'stopped'
                ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                : 'bg-amber-100 text-amber-700';
        return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${cls}`}>{status}</span>;
    };

    const allCfgTags = Array.from(new Set(configs.flatMap(c => c.tags ?? []))).sort((a, b) => a.localeCompare(b));

    // ── Render ────────────────────────────────────────────────────────────
    return (
        <div className="space-y-4 animate-fade-in">
            {globalError && (
                <div className="glass-card p-3 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs">
                    <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />
                    {globalError}
                </div>
            )}

            {/* Tabs */}
            <div className="glass-card overflow-hidden">
                <div className="p-2 border-b border-[var(--border-color)]">
                    <div
                        role="tablist"
                        aria-label="BNGBlaster sections"
                        className="flex gap-1 p-1 rounded-xl bg-[var(--bg-hover)] overflow-x-auto"
                    >
                        <Tab active={tab === 'dashboard'} onClick={() => setTab('dashboard')} icon={PresentationChartLineIcon} label="Dashboard" />
                        {role === 'admin' && (
                            <Tab active={tab === 'servers'} onClick={() => setTab('servers')} icon={ServerIcon} label="Servers" badge={servers.length} />
                        )}
                        <Tab active={tab === 'configs'} onClick={() => setTab('configs')} icon={Cog6ToothIcon} label="Configs" badge={configs.length} />
                        <Tab active={tab === 'run'} onClick={() => setTab('run')} icon={PlayCircleIcon} label="Run & Monitor" />
                        <Tab active={tab === 'reports'} onClick={() => setTab('reports')} icon={ChartBarIcon} label="Reports" />
                    </div>
                </div>

                <div className="p-4">

                    {/* ══ Shared VLAN Subinterfaces Observer (hidden on Dashboard) ══ */}
                    {selServer && tab !== 'dashboard' && (
                        <div className="mb-4 rounded-xl border border-teal-400/40 bg-teal-500/5 overflow-hidden">
                            {/* Header */}
                            <div className="flex items-center justify-between px-3 py-2">
                                <div className="flex items-center gap-2 min-w-0">
                                    <ServerIcon className="w-3.5 h-3.5 text-teal-500 shrink-0" />
                                    <span className="text-xs font-semibold text-[var(--text-primary)]">VLAN Subinterfaces</span>
                                    <span className="text-[11px] font-mono text-teal-600 dark:text-teal-400 truncate">
                                        {selServer.name} <span className="text-[var(--text-muted)]">({selServer.host})</span>
                                    </span>
                                    {!vlanIfacesLoading && !vlanIfacesError && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-500/20 text-teal-700 dark:text-teal-300 font-bold shrink-0">
                                            {vlanIfaces.length}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    <button
                                        onClick={() => fetchVlanIfaces(selServer)}
                                        disabled={vlanIfacesLoading}
                                        title="Refresh VLAN interfaces via SSH"
                                        className="p-1 rounded text-[var(--text-muted)] hover:text-teal-500 disabled:opacity-40 transition-colors"
                                    >
                                        <ArrowPathIcon className={`w-3.5 h-3.5 ${vlanIfacesLoading ? 'animate-spin' : ''}`} />
                                    </button>
                                    <button
                                        onClick={() => setVlanPanelOpen(v => !v)}
                                        title={vlanPanelOpen ? 'Collapse' : 'Expand'}
                                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                                    >
                                        <ChevronUpIcon className={`w-3.5 h-3.5 transition-transform duration-200 ${vlanPanelOpen ? '' : 'rotate-180'}`} />
                                    </button>
                                </div>
                            </div>

                            {/* Body — collapsible */}
                            {vlanPanelOpen && (
                                <div className="px-3 pb-3 border-t border-teal-400/20">
                                    {vlanIfacesLoading ? (
                                        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-2">
                                            <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />Fetching via SSH…
                                        </div>
                                    ) : vlanIfacesError ? (
                                        <p className="text-xs text-red-500 py-2">{vlanIfacesError}</p>
                                    ) : vlanIfaces.length === 0 ? (
                                        <p className="text-xs text-[var(--text-muted)] py-2">No VLAN subinterfaces on this server.</p>
                                    ) : (
                                        <div className="flex flex-wrap gap-1.5 pt-2">
                                            {vlanIfaces.map(iface => (
                                                <span
                                                    key={iface}
                                                    className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-teal-500/10 text-[var(--text-primary)] border border-teal-400/50"
                                                >
                                                    {iface}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ══════════════ TAB: DASHBOARD ══════════════ */}
                    {tab === 'dashboard' && <DashboardTab />}

                    {/* ══════════════ TAB: SERVERS (admin only) ══════════════ */}
                    {tab === 'servers' && role === 'admin' && (
                        <div className="space-y-4">
                            {/* SSH Credentials mặc định */}
                            <div className="glass-card p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                                        <Cog6ToothIcon className="w-4 h-4" />SSH Credentials mặc định
                                    </h3>
                                    {credsSaved && <span className="text-xs text-green-500">✓ Đã lưu</span>}
                                </div>
                                <p className="text-xs text-[var(--text-muted)]">
                                    Username &amp; Password SSH vào BNG server để tạo sub-interface. Tự động điền khi thêm server mới.
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">SSH Username</label>
                                        <input
                                            className="input-field text-sm"
                                            placeholder="root"
                                            value={defaultSshUser}
                                            onChange={e => setDefaultSshUser(e.target.value)}
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">SSH Password</label>
                                        <div className="relative">
                                            <input
                                                type={showCredPass ? 'text' : 'password'}
                                                className="input-field text-sm pr-9"
                                                placeholder="••••••••"
                                                value={defaultSshPass}
                                                onChange={e => setDefaultSshPass(e.target.value)}
                                                autoComplete="new-password"
                                            />
                                            <button
                                                type="button"
                                                aria-label={showCredPass ? 'Hide password' : 'Show password'}
                                                title={showCredPass ? 'Hide password' : 'Show password'}
                                                onClick={() => setShowCredPass(v => !v)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                                            >
                                                {showCredPass
                                                    ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                                                    : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                                }
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={handleSaveCreds}
                                    disabled={credsSaving}
                                    className="btn-primary text-sm disabled:opacity-50"
                                >
                                    {credsSaving ? 'Saving…' : 'Save Credentials'}
                                </button>
                            </div>

                            {/* Add server form */}
                            <div className="glass-card p-4 space-y-3">
                                <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2"><PlusIcon className="w-4 h-4" />Add BNGBlaster Server</h3>

                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">Display Name</label>
                                        <input className="input-field text-sm" placeholder="My BNG Lab" value={svrName} onChange={e => setSvrName(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">Host / IP <span className="text-red-500">*</span></label>
                                        <input className="input-field text-sm" placeholder="192.168.1.100" value={svrHost} onChange={e => setSvrHost(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && handleAddServer()} />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">Port</label>
                                        <input className="input-field text-sm" type="number" placeholder="8001" value={svrPort} onChange={e => setSvrPort(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">
                                            SSH User <span className="text-gray-400 font-normal">(để tạo sub-interface)</span>
                                        </label>
                                        <input
                                            className="input-field text-sm"
                                            placeholder="root"
                                            value={svrSshUser}
                                            onChange={e => setSvrSshUser(e.target.value)}
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">SSH Password</label>
                                        <input
                                            className="input-field text-sm"
                                            type="password"
                                            placeholder="••••••••"
                                            value={svrSshPass}
                                            onChange={e => setSvrSshPass(e.target.value)}
                                            autoComplete="new-password"
                                        />
                                    </div>
                                </div>
                                <button onClick={handleAddServer} disabled={!svrHost.trim() || svrSaving}
                                    className="btn-primary text-sm disabled:opacity-50">
                                    <PlusIcon className="w-4 h-4" />{svrSaving ? 'Adding…' : 'Add Server'}
                                </button>
                            </div>

                            {/* Server list */}
                            {servers.length === 0
                                ? <p className="text-sm text-[var(--text-muted)] text-center py-6">No servers added yet.</p>
                                : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-[var(--border-color)]">
                                                    {['Name', 'Host', 'Port', 'SSH User', 'Actions'].map(h => (
                                                        <th key={h} className="text-left py-2 px-3 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">{h}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {servers.map(s => (
                                                    <tr key={s.id} className={`border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] ${editingServer?.id === s.id ? 'bg-orange-500/10' : ''}`}>
                                                        <td className="py-2 px-3 font-medium">{s.name}</td>
                                                        <td className="py-2 px-3 font-mono text-xs">{s.host}</td>
                                                        <td className="py-2 px-3">{s.port}</td>
                                                        <td className="py-2 px-3 text-xs text-[var(--text-muted)]">{s.ssh_user || '—'}</td>
                                                        <td className="py-2 px-3">
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={() => editingServer?.id === s.id ? setEditingServer(null) : handleEditServer(s)}
                                                                    className="text-blue-400 hover:text-blue-600 transition-colors"
                                                                    title="Edit server"
                                                                >
                                                                    <PencilSquareIcon className="w-4 h-4" />
                                                                </button>
                                                                <button
                                                                    onClick={() => cleanupServer?.id === s.id ? setCleanupServer(null) : handleOpenCleanup(s)}
                                                                    className="text-amber-400 hover:text-amber-600 transition-colors"
                                                                    title="Cleanup VLAN subinterfaces via SSH"
                                                                >
                                                                    <WrenchScrewdriverIcon className="w-4 h-4" />
                                                                </button>
                                                                <button onClick={() => handleDeleteServer(s.id)} className="text-red-400 hover:text-red-600 transition-colors" title="Delete server">
                                                                    <TrashIcon className="w-4 h-4" />
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                            {/* ── Inline Edit Server Form ── */}
                            {editingServer && (
                                <div className="glass-card p-4 space-y-3 border-2 border-orange-300 bg-orange-500/5">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                                            <PencilSquareIcon className="w-4 h-4 text-orange-500" />
                                            Edit Server: <span className="text-orange-600">{editingServer.name}</span>
                                        </h3>
                                        <button onClick={() => setEditingServer(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                                            <XMarkIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div>
                                            <label className="block text-xs text-[var(--text-muted)] mb-1">Display Name</label>
                                            <input className="input-field text-sm" placeholder="My BNG Lab" value={editSvrName} onChange={e => setEditSvrName(e.target.value)} />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-[var(--text-muted)] mb-1">Host / IP <span className="text-red-500">*</span></label>
                                            <input className="input-field text-sm" placeholder="192.168.1.100" value={editSvrHost} onChange={e => setEditSvrHost(e.target.value)} />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-[var(--text-muted)] mb-1">Port</label>
                                            <input className="input-field text-sm" type="number" placeholder="8001" value={editSvrPort} onChange={e => setEditSvrPort(e.target.value)} />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-[var(--text-muted)] mb-1">SSH User</label>
                                            <input className="input-field text-sm" placeholder="root" value={editSvrSshUser} onChange={e => setEditSvrSshUser(e.target.value)} autoComplete="off" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-[var(--text-muted)] mb-1">SSH Password</label>
                                            <input className="input-field text-sm" type="password" placeholder="••••••••" value={editSvrSshPass} onChange={e => setEditSvrSshPass(e.target.value)} autoComplete="new-password" />
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={handleUpdateServer} disabled={!editSvrHost.trim() || editSvrSaving} className="btn-primary text-sm disabled:opacity-50">
                                            {editSvrSaving ? 'Saving…' : 'Update Server'}
                                        </button>
                                        <button onClick={() => setEditingServer(null)} className="btn-secondary text-sm">Cancel</button>
                                    </div>
                                </div>
                            )}

                            {/* ── Cleanup VLAN Subinterfaces Panel ── */}
                            {cleanupServer && (
                                <div className="glass-card p-4 space-y-3 border-2 border-amber-300 bg-amber-50/40">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                                            <WrenchScrewdriverIcon className="w-4 h-4 text-amber-500" />
                                            Cleanup VLAN Interfaces — <span className="text-amber-600">{cleanupServer.name}</span>
                                            <span className="text-xs font-normal text-[var(--text-muted)] font-mono">({cleanupServer.host})</span>
                                        </h3>
                                        <button onClick={() => { setCleanupServer(null); setCleanupResult(null); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                                            <XMarkIcon className="w-4 h-4" />
                                        </button>
                                    </div>

                                    {cleanupListLoading ? (
                                        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                                            <ArrowPathIcon className="w-4 h-4 animate-spin" /> Fetching interfaces via SSH…
                                        </div>
                                    ) : cleanupIfaces.length === 0 ? (
                                        <p className="text-sm text-[var(--text-muted)] py-2">No VLAN subinterfaces found on this server.</p>
                                    ) : (
                                        <>
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-xs text-[var(--text-muted)]">{cleanupIfaces.length} VLAN interface(s) found</span>
                                                <button
                                                    onClick={() => setSelectedCleanupIfaces(new Set(cleanupIfaces))}
                                                    className="text-xs text-blue-500 hover:underline"
                                                >Select All</button>
                                                <span className="text-[var(--text-muted)]">·</span>
                                                <button
                                                    onClick={() => setSelectedCleanupIfaces(new Set())}
                                                    className="text-xs text-gray-500 hover:underline"
                                                >Deselect All</button>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto pr-1">
                                                {cleanupIfaces.map(iface => (
                                                    <label key={iface} className="flex items-center gap-1.5 cursor-pointer px-2 py-1.5 rounded-lg border border-[var(--border-color)] hover:bg-amber-100 transition-colors text-xs font-mono">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedCleanupIfaces.has(iface)}
                                                            onChange={e => {
                                                                const next = new Set(selectedCleanupIfaces);
                                                                if (e.target.checked) next.add(iface); else next.delete(iface);
                                                                setSelectedCleanupIfaces(next);
                                                            }}
                                                            className="rounded"
                                                        />
                                                        {iface}
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <button
                                                    onClick={handleCleanupIfaces}
                                                    disabled={selectedCleanupIfaces.size === 0 || cleanupExeLoading}
                                                    className="btn-primary text-sm bg-red-500 hover:bg-red-600 border-red-500 disabled:opacity-50 flex items-center gap-1.5"
                                                >
                                                    {cleanupExeLoading
                                                        ? <><ArrowPathIcon className="w-4 h-4 animate-spin" />Deleting…</>
                                                        : <><TrashIcon className="w-4 h-4" />Delete Selected ({selectedCleanupIfaces.size})</>}
                                                </button>
                                                <button
                                                    onClick={() => handleOpenCleanup(cleanupServer)}
                                                    disabled={cleanupListLoading || cleanupExeLoading}
                                                    className="btn-secondary text-sm disabled:opacity-50 flex items-center gap-1"
                                                >
                                                    <ArrowPathIcon className="w-3.5 h-3.5" />Refresh
                                                </button>
                                            </div>
                                        </>
                                    )}

                                    {/* Cleanup result */}
                                    {cleanupResult && (
                                        <div className={`text-xs rounded-lg border px-3 py-2 flex items-start gap-2 ${cleanupResult.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                                            {cleanupResult.success
                                                ? <CheckCircleIcon className="w-4 h-4 shrink-0 mt-0.5 text-green-500" />
                                                : <ExclamationTriangleIcon className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />}
                                            <div className="flex-1 min-w-0">
                                                <span className="font-semibold">{cleanupResult.success ? 'Success' : 'Error'}:</span> {cleanupResult.msg}
                                                {!cleanupResult.success && (cleanupResult.stderr || cleanupResult.stdout) && (
                                                    <pre className="mt-1 px-2 py-1 rounded bg-red-100 text-[10px] font-mono whitespace-pre-wrap max-h-24 overflow-auto">
                                                        {[cleanupResult.stderr, cleanupResult.stdout].filter(Boolean).join('\n')}
                                                    </pre>
                                                )}
                                            </div>
                                            <button onClick={() => setCleanupResult(null)} aria-label="Dismiss" title="Dismiss" className="shrink-0 opacity-50 hover:opacity-100">✕</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ══════════════ TAB: CONFIGS ══════════════ */}
                    {tab === 'configs' && (
                        <div className="space-y-4">
                            {/* Sub-tab bar: Editor | Builder */}
                            <div role="tablist" aria-label="Config editing mode" className="flex border-b border-[var(--border-color)] gap-1">
                                <button
                                    role="tab"
                                    aria-selected={cfgSubTab === 'editor'}
                                    onClick={() => setCfgSubTab('editor')}
                                    className={`px-4 py-2 text-xs font-medium border-b-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${cfgSubTab === 'editor' ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                                >
                                    JSON Editor
                                </button>
                                <button
                                    role="tab"
                                    aria-selected={cfgSubTab === 'builder'}
                                    onClick={() => setCfgSubTab('builder')}
                                    className={`px-4 py-2 text-xs font-medium border-b-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${cfgSubTab === 'builder' ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                                >
                                    Visual Builder
                                </button>
                            </div>

                            {/* ── JSON Editor sub-tab ── */}
                            {cfgSubTab === 'editor' && (
                                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                                    {/* ── Saved Configs panel ── */}
                                    <div className="lg:col-span-2 glass-card border-t-2 border-t-cyan-500 overflow-hidden">
                                        {/* Panel header */}
                                        <div className="flex items-center justify-between px-3 py-2.5 bg-cyan-500/10 border-b border-cyan-500/20">
                                            <div className="flex items-center gap-2">
                                                <ClipboardDocumentListIcon className="w-4 h-4 text-cyan-500 shrink-0" />
                                                <span className="text-sm font-semibold text-cyan-600 dark:text-cyan-400">Saved Configs</span>
                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-600 dark:text-cyan-300 font-semibold">{configs.length}</span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <button
                                                    onClick={handleExportAllConfigs}
                                                    disabled={configs.length === 0}
                                                    title="Export all configs (.json backup)"
                                                    className="btn-secondary text-xs disabled:opacity-40"
                                                >
                                                    <ArrowDownTrayIcon className="w-3 h-3" />Export All
                                                </button>
                                                {can.createBNGConfig(role) && (
                                                    <>
                                                        <input
                                                            ref={importFileInputRef}
                                                            type="file"
                                                            accept="application/json,.json"
                                                            multiple
                                                            className="hidden"
                                                            onChange={e => { handleImportFiles(e.target.files); e.target.value = ''; }}
                                                        />
                                                        <button
                                                            onClick={() => importFileInputRef.current?.click()}
                                                            title="Import config(s) from .json file"
                                                            className="btn-secondary text-xs"
                                                        >
                                                            <ArrowUpTrayIcon className="w-3 h-3" />Import
                                                        </button>
                                                        <button onClick={startNewConfig} className="btn-secondary text-xs">
                                                            <PlusIcon className="w-3 h-3" />New
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        {/* Filter + Search */}
                                        <div className="p-3 space-y-2">
                                            <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden text-[11px] font-semibold">
                                                {([['all', 'All'], ['running', 'Running'], ['idle', 'Idle']] as const).map(([f, label]) => (
                                                    <button key={f} aria-pressed={savedCfgFilter === f} onClick={() => setSavedCfgFilter(f)}
                                                        className={`flex-1 py-1 transition-colors ${savedCfgFilter === f ? 'bg-cyan-500 text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}>
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                            <input
                                                type="text" value={savedCfgSearch} onChange={e => setSavedCfgSearch(e.target.value)}
                                                placeholder="Search…"
                                                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] focus:outline-none focus:ring-1 focus:ring-cyan-400"
                                            />
                                            {(() => {
                                                const visible = configs.filter(c => {
                                                    const instName = toInstanceName(c.name);
                                                    const inst = allInstances.find(i => i.name === instName);
                                                    const isRunning = inst?.status === 'started';
                                                    if (savedCfgFilter === 'running' && !isRunning) return false;
                                                    if (savedCfgFilter === 'idle' && isRunning) return false;
                                                    const q = savedCfgSearch.toLowerCase().trim();
                                                    return !q || c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q);
                                                });
                                                if (configs.length === 0) return <p className="text-xs text-[var(--text-muted)] text-center py-4">No configs yet.</p>;
                                                if (visible.length === 0) return <p className="text-xs text-[var(--text-muted)] text-center py-4">No configs match.</p>;
                                                const visibleIds = visible.map(v => v.id);
                                                const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedCfgIds.has(id));
                                                const selCount = selectedCfgIds.size;
                                                return (
                                                    <div className="space-y-2">
                                                        {/* Bulk selection bar */}
                                                        <div className="flex items-center gap-2 flex-wrap px-1">
                                                            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] cursor-pointer select-none">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={allVisibleSelected}
                                                                    onChange={() => setSelectedCfgIds(prev => {
                                                                        const next = new Set(prev);
                                                                        if (allVisibleSelected) visibleIds.forEach(id => next.delete(id));
                                                                        else visibleIds.forEach(id => next.add(id));
                                                                        return next;
                                                                    })}
                                                                    className="rounded border-[var(--border-color)] text-cyan-500 focus:ring-cyan-400"
                                                                />
                                                                Select all
                                                            </label>
                                                            {selCount > 0 && (
                                                                <>
                                                                    <span className="text-[11px] font-semibold text-cyan-600 dark:text-cyan-400">{selCount} selected</span>
                                                                    <div className="flex-1" />
                                                                    <button onClick={handleBulkDownload} className="btn-secondary text-xs" title="Download each selected config (.json)">
                                                                        <ArrowDownTrayIcon className="w-3 h-3" />Download
                                                                    </button>
                                                                    <button onClick={handleBulkDelete}
                                                                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-red-300 text-red-600 hover:bg-red-500/10 transition-colors"
                                                                        title="Delete selected configs you have permission to delete">
                                                                        <TrashIcon className="w-3 h-3" />Delete
                                                                    </button>
                                                                    <button onClick={clearCfgSelection} className="btn-secondary text-xs">Clear</button>
                                                                </>
                                                            )}
                                                        </div>
                                                        {visible.map(c => {
                                                            const instName = toInstanceName(c.name);
                                                            const inst = allInstances.find(i => i.name === instName);
                                                            const isOwner = c.is_owner !== false;
                                                            const canEdit   = can.editBNGConfig(role, isOwner);
                                                            const canDelete = can.deleteBNGConfig(role, isOwner);
                                                            const canRun    = can.runBNGInstance(role, isOwner);
                                                            return (
                                                                <div key={c.id}
                                                                    onClick={() => canEdit && startEditConfig(c)}
                                                                    {...(canEdit ? {
                                                                        role: 'button',
                                                                        tabIndex: 0,
                                                                        'aria-label': `Edit config ${c.name}`,
                                                                        onKeyDown: (e: React.KeyboardEvent) => {
                                                                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEditConfig(c); }
                                                                        },
                                                                    } : {})}
                                                                    className={`rounded-lg border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${canEdit ? 'cursor-pointer hover:border-cyan-400 hover:bg-cyan-500/5' : 'cursor-default'} ${editingCfg?.id === c.id ? 'border-orange-500 bg-orange-500/10 shadow-sm' : 'border-[var(--border-color)] bg-[var(--bg-card)]'} ${selectedCfgIds.has(c.id) ? 'ring-1 ring-cyan-400' : ''}`}>
                                                                    <div className="flex items-start justify-between gap-2">
                                                                        <div className="flex items-start gap-2 min-w-0">
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={selectedCfgIds.has(c.id)}
                                                                                onClick={e => e.stopPropagation()}
                                                                                onChange={() => toggleCfgSelected(c.id)}
                                                                                className="mt-1 shrink-0 rounded border-[var(--border-color)] text-cyan-500 focus:ring-cyan-400"
                                                                                title="Select for bulk action"
                                                                            />
                                                                        <div className="min-w-0">
                                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                                <p className="text-sm font-semibold truncate">{c.name}</p>
                                                                                {inst && <StatusBadge status={inst.status} />}
                                                                                {!isOwner && c.owner_username && (
                                                                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium" title={`Owned by ${c.owner_username}`}>
                                                                                        @{c.owner_username}
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                            {c.description && <p className="text-xs text-[var(--text-muted)] truncate">{c.description}</p>}
                                                                            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                                                                {c.updated_at ? new Date(c.updated_at).toLocaleString() : '—'}
                                                                            </p>
                                                                        </div>
                                                                        </div>
                                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                                            {canRun && (() => {
                                                                                const iName = toInstanceName(c.name);
                                                                                const iInst = allInstances.find(i => i.name === iName);
                                                                                const iStarting = startingConfigId === c.id;
                                                                                return iInst?.status === 'started' ? (
                                                                                    <span className="text-[10px] text-green-600 font-semibold flex items-center gap-1" title={`Instance "${iName}" is running`}>
                                                                                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                                                                                        Running
                                                                                    </span>
                                                                                ) : (
                                                                                    <button
                                                                                        onClick={e => { e.stopPropagation(); handleStartFromConfig(c); }}
                                                                                        disabled={!selServer || iStarting}
                                                                                        className="text-green-500 hover:text-green-700 disabled:opacity-40 transition-colors"
                                                                                        title={!selServer ? 'Select a server in Run & Monitor tab first' : `Start instance "${iName}"`}
                                                                                    >
                                                                                        {iStarting
                                                                                            ? <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
                                                                                            : <PlayCircleIcon className="w-3.5 h-3.5" />}
                                                                                    </button>
                                                                                );
                                                                            })()}
                                                                            <button onClick={e => { e.stopPropagation(); setTopologyModalCfg(c); }}
                                                                                className="text-gray-400 hover:text-cyan-600 transition-colors" title="Preview topology">
                                                                                <ShareIcon className="w-3.5 h-3.5" />
                                                                            </button>
                                                                            <button onClick={e => { e.stopPropagation(); handleDownloadConfig(c); }}
                                                                                className="text-gray-400 hover:text-emerald-600 transition-colors" title="Download config.json">
                                                                                <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                                                                            </button>
                                                                            <button onClick={e => { e.stopPropagation(); handleCloneConfig(c); }}
                                                                                className="text-gray-400 hover:text-blue-500 transition-colors" title="Clone config">
                                                                                <DocumentDuplicateIcon className="w-3.5 h-3.5" />
                                                                            </button>
                                                                            {canDelete && (
                                                                                <button onClick={e => { e.stopPropagation(); handleDeleteConfig(c.id); }}
                                                                                    className="text-red-400 hover:text-red-600 transition-colors" title="Delete config">
                                                                                    <TrashIcon className="w-3.5 h-3.5" />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>

                                    {/* ── Editor panel ── */}
                                    <div className={`lg:col-span-3 glass-card border-t-2 overflow-hidden ${editingCfg ? 'border-t-orange-500' : 'border-t-emerald-500'}`}>
                                        {/* Panel header */}
                                        <div className={`flex items-center gap-2 px-3 py-2.5 border-b ${editingCfg ? 'bg-orange-500/10 border-orange-500/20' : 'bg-emerald-500/10 border-emerald-500/20'}`}>
                                            {editingCfg
                                                ? <PencilSquareIcon className="w-4 h-4 text-orange-500 shrink-0" />
                                                : <PlusIcon className="w-4 h-4 text-emerald-500 shrink-0" />}
                                            <span className={`text-sm font-semibold ${editingCfg ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                                {editingCfg ? `Editing: ${editingCfg.name}` : 'New Config'}
                                            </span>
                                        </div>
                                        {/* Form */}
                                        <div className="p-3 space-y-3">
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                <div>
                                                    <label className="block text-xs text-[var(--text-muted)] mb-1">Name <span className="text-red-500">*</span></label>
                                                    <input
                                                        className={`input-field text-sm ${nameConflict ? 'border-red-500 focus:ring-red-400' : ''}`}
                                                        placeholder="my-test-profile"
                                                        value={cfgName}
                                                        onChange={e => setCfgName(e.target.value)}
                                                    />
                                                    {nameConflict && (
                                                        <p className="text-[11px] text-red-500 mt-1 flex items-center gap-1">
                                                            <ExclamationTriangleIcon className="w-3 h-3" />
                                                            Name already used{nameConflict.owner_username ? ` by @${nameConflict.owner_username}` : ''}. Config names must be unique.
                                                        </p>
                                                    )}
                                                </div>
                                                <div>
                                                    <label className="block text-xs text-[var(--text-muted)] mb-1">Description</label>
                                                    <input className="input-field text-sm" placeholder="Optional description" value={cfgDesc} onChange={e => setCfgDesc(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className="block text-xs text-[var(--text-muted)] mb-1">Tags</label>
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        {cfgTags.map(t => (
                                                            <span key={t} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-cyan-500/12 text-cyan-700 dark:text-cyan-300 border border-cyan-500/25">
                                                                {t}
                                                                <button type="button" onClick={() => setCfgTags(prev => prev.filter(x => x !== t))} className="hover:text-red-500" aria-label={`Remove tag ${t}`}>×</button>
                                                            </span>
                                                        ))}
                                                        <input
                                                            className="input-field text-sm flex-1 min-w-[8rem]"
                                                            placeholder={cfgTags.length >= 10 ? 'Max 10 tags' : 'Add tag + Enter'}
                                                            disabled={cfgTags.length >= 10}
                                                            list="cfg-tag-suggestions"
                                                            value={cfgTagInput}
                                                            onChange={e => setCfgTagInput(e.target.value)}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCfgTag(cfgTagInput); }
                                                                else if (e.key === 'Backspace' && !cfgTagInput && cfgTags.length) setCfgTags(prev => prev.slice(0, -1));
                                                            }}
                                                        />
                                                        <datalist id="cfg-tag-suggestions">
                                                            {allCfgTags.filter(t => !cfgTags.includes(t)).map(t => <option key={t} value={t} />)}
                                                        </datalist>
                                                    </div>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs text-[var(--text-muted)] mb-1">config.json</label>
                                                <ResizableEditorBox defaultHeight={320}>
                                                    <Editor
                                                        height="100%" theme="vs-dark" language="json"
                                                        value={cfgJson}
                                                        onChange={v => setCfgJson(v || '')}
                                                        options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
                                                    />
                                                </ResizableEditorBox>
                                            </div>
                                            {cfgError && <p className="text-xs text-red-500 flex items-center gap-1"><ExclamationTriangleIcon className="w-3.5 h-3.5" />{cfgError}</p>}
                                            <div className="flex gap-2">
                                                <button onClick={handleSaveConfig} disabled={cfgSaving || !!nameConflict}
                                                    className={`text-sm disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${editingCfg ? 'bg-orange-500 hover:bg-orange-600 text-white' : 'bg-emerald-500 hover:bg-emerald-600 text-white'}`}>
                                                    {cfgSaving ? 'Saving…' : editingCfg ? 'Update Config' : 'Save Config'}
                                                </button>
                                                {editingCfg && <button onClick={startNewConfig} className="btn-secondary text-sm"><PlusIcon className="w-3.5 h-3.5" />New Config</button>}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* ── Visual Builder sub-tab ── */}
                            {cfgSubTab === 'builder' && (
                                <div className="space-y-3">
                                    <p className="text-xs text-[var(--text-muted)]">
                                        Select sections and fill in parameters visually. Click <strong>Use this Config</strong> to load the generated JSON into the editor, then save it.
                                    </p>
                                    <ConfigBuilder
                                        onUseConfig={json => {
                                            setCfgJson(JSON.stringify(json, null, 2));
                                            setCfgSubTab('editor');
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    {/* ══════════════ TAB: RUN & MONITOR ══════════════ */}
                    {tab === 'run' && (
                        <div className="space-y-4">

                            {/* ── Server selector bar ── */}
                            <div className="glass-card overflow-hidden">
                                <div className="flex items-center gap-2 px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
                                    <ServerIcon className="w-4 h-4 text-[var(--text-muted)]" />
                                    <span className="text-sm font-semibold text-[var(--text-primary)]">BNGBlaster Server</span>
                                    {selServer && (
                                        <span className="text-xs font-mono text-[var(--text-muted)] ml-1">{selServer.host}:{selServer.port}</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 p-4">
                                    <select className="input-field text-sm flex-1" value={selServer?.id ?? ''}
                                        onChange={e => {
                                            const s = servers.find(x => x.id === Number(e.target.value)) || null;
                                            setSelServer(s);
                                            setAllInstances([]); stopMonitoring(); setActiveMonitorInstance(null);
                                            if (s) loadInstances(s);
                                        }}>
                                        <option value="">Select server…</option>
                                        {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host}:{s.port})</option>)}
                                    </select>
                                    <button
                                        onClick={() => selServer && loadInstances(selServer)}
                                        disabled={!selServer || loadingInstances}
                                        className="btn-secondary text-xs disabled:opacity-50"
                                        title="Refresh instance list"
                                    >
                                        <ArrowPathIcon className={`w-3.5 h-3.5 ${loadingInstances ? 'animate-spin' : ''}`} />
                                        {loadingInstances ? 'Loading…' : 'Refresh'}
                                    </button>
                                </div>
                            </div>

                            {/* Global messages */}
                            {runMsg   && <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg"><CheckCircleIcon className="w-4 h-4 shrink-0" />{runMsg}</div>}
                            {runError && <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg"><ExclamationTriangleIcon className="w-4 h-4 shrink-0" />{runError}</div>}
                            {ifaceSetupLog && (
                                <div className={`text-xs rounded-lg border ${ifaceSetupLog.ok ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                                    <div className="flex items-start gap-2 px-3 py-2">
                                        {ifaceSetupLog.ok
                                            ? <CheckCircleIcon className="w-4 h-4 shrink-0 mt-0.5 text-blue-500" />
                                            : <ExclamationTriangleIcon className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />}
                                        <div className="min-w-0 flex-1">
                                            <span className="font-semibold">VLAN setup:</span> {ifaceSetupLog.msg}
                                            {ifaceSetupLog.ifaces.length > 0 && (
                                                <span className="ml-1 font-mono text-[10px] opacity-70">({ifaceSetupLog.ifaces.join(', ')})</span>
                                            )}
                                        </div>
                                        <button onClick={() => setIfaceSetupLog(null)} aria-label="Dismiss" title="Dismiss" className="shrink-0 opacity-50 hover:opacity-100">✕</button>
                                    </div>
                                    {/* Show SSH output detail on failure */}
                                    {!ifaceSetupLog.ok && (ifaceSetupLog.stderr || ifaceSetupLog.stdout) && (
                                        <pre className="mx-3 mb-2 px-2 py-1.5 rounded bg-red-100 text-[10px] font-mono whitespace-pre-wrap max-h-28 overflow-auto text-red-900">
                                            {[ifaceSetupLog.stderr, ifaceSetupLog.stdout].filter(Boolean).join('\n')}
                                        </pre>
                                    )}
                                </div>
                            )}

                            {/* ══ TOP: Instances on Server ══ */}
                            <div className="glass-card border-t-2 border-t-cyan-500 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-3 bg-cyan-500/10 border-b border-cyan-400/30">
                                    <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                                        <ServerIcon className="w-4 h-4 text-cyan-500" />
                                        <span className="text-cyan-600 dark:text-cyan-400">Instances on Server</span>
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] bg-[var(--bg-primary)] text-[var(--text-muted)] px-2 py-0.5 rounded-full font-bold">
                                            {allInstances.length} total · {allInstances.filter(i => i.status === 'started').length} running
                                        </span>
                                        {/* Filter toggle */}
                                        <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden text-[11px] font-semibold">
                                            {(['running', 'all'] as const).map(f => (
                                                <button
                                                    key={f}
                                                    aria-pressed={instFilter === f} onClick={() => setInstFilter(f)}
                                                    className={`px-2.5 py-1 transition-colors ${
                                                        instFilter === f
                                                            ? 'bg-cyan-500 text-white'
                                                            : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                                                    }`}
                                                >
                                                    {f === 'running' ? 'Running' : 'All'}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* Search box */}
                                {allInstances.length > 0 && (
                                    <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-card)]">
                                        <input
                                            type="text"
                                            value={instSearch}
                                            onChange={e => setInstSearch(e.target.value)}
                                            placeholder="Filter by name…"
                                            className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] focus:outline-none focus:ring-1 focus:ring-cyan-400"
                                        />
                                    </div>
                                )}

                                {!selServer ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-8">Select a BNG server above.</p>
                                ) : loadingInstances ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading instances…</p>
                                ) : allInstances.length === 0 ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-8">No instances found on this server.</p>
                                ) : (() => {
                                    const filtered = allInstances
                                        .filter(i => instFilter === 'all' || i.status === 'started')
                                        .filter(i => !instSearch.trim() || i.name.toLowerCase().includes(instSearch.toLowerCase()));
                                    return filtered.length === 0 ? (
                                        <p className="text-sm text-[var(--text-muted)] text-center py-8">
                                            {instFilter === 'running' ? 'No running instances.' : 'No instances match the filter.'}
                                        </p>
                                    ) : (
                                    <div className="divide-y divide-[var(--border-color)]">
                                        {filtered.map(inst => {
                                            const isRunning = inst.status === 'started';
                                            const isMonitored = activeMonitorInstance === inst.name && monitoring;
                                            const canControl = canControlInstance(inst.name);
                                            const ownerName  = getInstanceOwner(inst.name);
                                            const noPermTitle = ownerName
                                                ? `Owned by @${ownerName} — no permission`
                                                : 'No permission to control this instance';
                                            return (
                                                <div key={inst.name}>
                                                    {/* Instance row */}
                                                    <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 ${isMonitored ? 'bg-cyan-500/10' : 'hover:bg-[var(--bg-hover)]'} transition-colors`}>
                                                        <div className="flex items-center gap-3 min-w-0">
                                                            <span className="font-mono text-sm font-semibold truncate">{inst.name}</span>
                                                            <StatusBadge status={inst.status} />
                                                            {ownerName && (
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium" title={`Started by @${ownerName}`}>
                                                                    @{ownerName}
                                                                </span>
                                                            )}
                                                            {isMonitored && (
                                                                <span className="flex items-center gap-1 text-[10px] text-cyan-600 font-semibold">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse inline-block" />
                                                                    monitoring
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                            {isRunning && (
                                                                <>
                                                                    <button
                                                                        onClick={() => handleStop(inst.name)}
                                                                        disabled={!canControl || !!instActionLoading[`${inst.name}:stop`] || restartingInstance === inst.name}
                                                                        title={!canControl ? noPermTitle : 'Stop instance'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-amber-500 text-white font-semibold hover:bg-amber-600 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                                                    >
                                                                        <StopCircleIcon className="w-3.5 h-3.5" />
                                                                        {instActionLoading[`${inst.name}:stop`] ? 'Stopping…' : 'Stop'}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleRestart(inst.name)}
                                                                        disabled={!canControl || restartingInstance === inst.name || !!instActionLoading[`${inst.name}:stop`]}
                                                                        title={!canControl ? noPermTitle : 'Stop then restart with same config'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                                                    >
                                                                        <ArrowPathRoundedSquareIcon className={`w-3.5 h-3.5 ${restartingInstance === inst.name ? 'animate-spin' : ''}`} />
                                                                        {restartingInstance === inst.name ? 'Restarting…' : 'Restart'}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleKill(inst.name)}
                                                                        disabled={!canControl || !!instActionLoading[`${inst.name}:kill`]}
                                                                        title={!canControl ? noPermTitle : 'Force kill instance'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-600 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                                                    >
                                                                        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                                                                        {instActionLoading[`${inst.name}:kill`] ? 'Killing…' : 'Kill'}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => toggleMonitor(inst.name)}
                                                                        className={`text-xs px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 transition-colors ${
                                                                            isMonitored
                                                                                ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/25'
                                                                                : 'bg-cyan-500 text-white hover:bg-cyan-600'
                                                                        }`}
                                                                    >
                                                                        <BoltIcon className="w-3.5 h-3.5" />
                                                                        {isMonitored ? 'Stop Monitor' : 'Monitor'}
                                                                    </button>
                                                                </>
                                                            )}
                                                            <button
                                                                onClick={() => handleViewInstanceConfig(inst.name)}
                                                                className={`text-xs px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 transition-colors ${
                                                                    viewConfigInstance === inst.name
                                                                        ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                                                        : 'btn-secondary'
                                                                }`}
                                                            >
                                                                <DocumentTextIcon className="w-3.5 h-3.5" />
                                                                {viewConfigInstance === inst.name ? 'Hide Config' : 'View Config'}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Config viewer panel */}
                                                    {viewConfigInstance === inst.name && (
                                                        <div className="px-4 pb-3 border-t border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                            <p className="text-[10px] text-[var(--text-muted)] py-2 font-semibold uppercase tracking-wide">config.json — {inst.name}</p>
                                                            {viewConfigLoading
                                                                ? <p className="text-xs text-gray-400 py-2">Loading…</p>
                                                                : <ResizableEditorBox defaultHeight={208} min={100}>
                                                                    <Editor height="100%" theme="vs-dark" language="json" value={viewConfigJson}
                                                                        options={{ readOnly: true, minimap: { enabled: false }, fontSize: 11, scrollBeyondLastLine: false }} />
                                                                </ResizableEditorBox>
                                                            }
                                                        </div>
                                                    )}

                                                    {/* Monitor panel — live stats */}
                                                    {isMonitored && (
                                                        <div className="border-t border-[var(--border-color)] bg-cyan-500/5 p-4 space-y-4">

                                                            {/* ── Network Interfaces ── */}
                                                            {netStats.length > 0 && (
                                                                <div className="space-y-2">
                                                                    <div className="flex items-center justify-between">
                                                                        <h5 className="text-xs font-bold uppercase tracking-wide text-indigo-500 flex items-center gap-1">
                                                                            <BoltIcon className="w-3 h-3" />Network Interfaces
                                                                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                                                        </h5>
                                                                        <div className="flex gap-1">
                                                                            <button onClick={() => downloadCsv(netStats, 'network-interfaces.csv', [{ key: 'name', label: 'Interface' }, { key: 'tx-pps', label: 'NW-TX(pps)' }, { key: 'rx-pps', label: 'NW-RX(pps)' }, { key: 'rx-loss-packets-streams', label: 'NW-LOSS(pkts-stream)' }])} className="text-indigo-400 hover:text-indigo-600" title="Download CSV"><ArrowDownTrayIcon className="w-3.5 h-3.5" /></button>
                                                                            <button onClick={() => setFullscreenTable('network')} className="text-indigo-400 hover:text-indigo-600" title="Fullscreen"><ArrowsPointingOutIcon className="w-3.5 h-3.5" /></button>
                                                                        </div>
                                                                    </div>
                                                                    {/* Sparklines */}
                                                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                                                        {netStats.map(iif => {
                                                                            const hist = netHistRef.current[iif.name] || [];
                                                                            return (
                                                                                <div key={iif.name} className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg p-2">
                                                                                    <div className="flex items-center justify-between mb-1">
                                                                                        <span className="text-[10px] font-mono font-semibold">{iif.name}</span>
                                                                                        {iif['rx-loss-packets-streams'] > 0 && (
                                                                                            <span className="text-[9px] text-red-500 font-bold">LOSS</span>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="flex gap-1">
                                                                                        <div className="flex-1 min-w-0">
                                                                                            <Sparkline data={hist.map(h => h.txPps)} color="#f97316" width={90} height={30} />
                                                                                            <p className="text-[9px] text-orange-500 font-semibold">TX {fmtPps(iif['tx-pps'])} pps</p>
                                                                                        </div>
                                                                                        <div className="flex-1 min-w-0">
                                                                                            <Sparkline data={hist.map(h => h.rxPps)} color="#6366f1" width={90} height={30} />
                                                                                            <p className="text-[9px] text-indigo-500 font-semibold">RX {fmtPps(iif['rx-pps'])} pps</p>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                    {/* Table */}
                                                                    <div className="overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]">
                                                                        <table className="w-full text-[10px]">
                                                                            <thead>
                                                                                <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                                                    {['Interface', 'NW-TX (pps)', 'NW-RX (pps)', 'NW-LOSS (pkts-stream)'].map(h => (
                                                                                        <th key={h} className="text-left py-1.5 px-2 text-indigo-600 font-semibold whitespace-nowrap">{h}</th>
                                                                                    ))}
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody>
                                                                                {netStats.map((iif, i) => (
                                                                                    <tr key={i} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]">
                                                                                        <td className="py-1.5 px-2 font-mono">{iif.name}</td>
                                                                                        <td className="py-1.5 px-2 text-orange-600 font-bold">{fmtPps(iif['tx-pps'])}</td>
                                                                                        <td className="py-1.5 px-2 text-indigo-600 font-bold">{fmtPps(iif['rx-pps'])}</td>
                                                                                        <td className={`py-1.5 px-2 font-bold ${iif['rx-loss-packets-streams'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-streams']}</td>
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* ── Access Interfaces ── */}
                                                            {accStats.length > 0 && (
                                                                <div className="space-y-2">
                                                                    <div className="flex items-center justify-between">
                                                                        <h5 className="text-xs font-bold uppercase tracking-wide text-blue-500 flex items-center gap-1">
                                                                            <BoltIcon className="w-3 h-3" />Access Interfaces
                                                                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                                                        </h5>
                                                                        <div className="flex gap-1">
                                                                            <button onClick={() => downloadCsv(accStats, 'access-interfaces.csv', [{ key: 'name', label: 'Interface' }, { key: 'tx-pps', label: 'AC-TX(pps)' }, { key: 'rx-pps', label: 'AC-RX(pps)' }, { key: 'rx-loss-packets-streams', label: 'AC-LOSS(stream)' }, { key: 'rx-loss-packets-multicast', label: 'AC-LOSS(mcast)' }])} className="text-blue-400 hover:text-blue-600" title="Download CSV"><ArrowDownTrayIcon className="w-3.5 h-3.5" /></button>
                                                                            <button onClick={() => setFullscreenTable('access')} className="text-blue-400 hover:text-blue-600" title="Fullscreen"><ArrowsPointingOutIcon className="w-3.5 h-3.5" /></button>
                                                                        </div>
                                                                    </div>
                                                                    {/* Sparklines */}
                                                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                                                        {accStats.map(iif => {
                                                                            const hist = accHistRef.current[iif.name] || [];
                                                                            return (
                                                                                <div key={iif.name} className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg p-2">
                                                                                    <div className="flex items-center justify-between mb-1">
                                                                                        <span className="text-[10px] font-mono font-semibold">{iif.name}</span>
                                                                                        {iif['rx-loss-packets-streams'] > 0 && (
                                                                                            <span className="text-[9px] text-red-500 font-bold">LOSS</span>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="flex gap-1">
                                                                                        <div className="flex-1 min-w-0">
                                                                                            <Sparkline data={hist.map(h => h.txPps)} color="#f97316" width={90} height={30} />
                                                                                            <p className="text-[9px] text-orange-500 font-semibold">TX {fmtPps(iif['tx-pps'])} pps</p>
                                                                                        </div>
                                                                                        <div className="flex-1 min-w-0">
                                                                                            <Sparkline data={hist.map(h => h.rxPps)} color="#0ea5e9" width={90} height={30} />
                                                                                            <p className="text-[9px] text-sky-500 font-semibold">RX {fmtPps(iif['rx-pps'])} pps</p>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                    {/* Table */}
                                                                    <div className="overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]">
                                                                        <table className="w-full text-[10px]">
                                                                            <thead>
                                                                                <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                                                    {['Interface', 'AC-TX (pps)', 'AC-RX (pps)', 'AC-LOSS (pkts-stream)', 'AC-LOSS (pkts-mcast)'].map(h => (
                                                                                        <th key={h} className="text-left py-1.5 px-2 text-blue-600 font-semibold whitespace-nowrap">{h}</th>
                                                                                    ))}
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody>
                                                                                {accStats.map((iif, i) => (
                                                                                    <tr key={i} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]">
                                                                                        <td className="py-1.5 px-2 font-mono">{iif.name}</td>
                                                                                        <td className="py-1.5 px-2 text-orange-600 font-bold">{fmtPps(iif['tx-pps'])}</td>
                                                                                        <td className="py-1.5 px-2 text-sky-600 font-bold">{fmtPps(iif['rx-pps'])}</td>
                                                                                        <td className={`py-1.5 px-2 font-bold ${iif['rx-loss-packets-streams'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-streams']}</td>
                                                                                        <td className={`py-1.5 px-2 font-bold ${iif['rx-loss-packets-multicast'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-multicast']}</td>
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* ── Stream Statistics ── */}
                                                            {monitorTotalFlows > 0 && (
                                                                <div className="space-y-2">
                                                                    <div className="flex items-center justify-between">
                                                                        <h5 className="text-xs font-bold uppercase tracking-wide text-purple-500 flex items-center gap-1">
                                                                            <ChartBarIcon className="w-3 h-3" />
                                                                            Stream Statistics
                                                                            <span className="font-normal text-gray-400">({monitorTotalFlows} flows total{selectedFlowIds.length > 0 ? ` · showing ${selectedFlowIds.length}` : ' · none selected'})</span>
                                                                        </h5>
                                                                    </div>
                                                                    {/* Flow selector */}
                                                                    <div className="bg-purple-500/5 border border-[var(--border-color)] rounded-lg p-2 space-y-2">
                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                            <input
                                                                                type="text"
                                                                                value={flowIdInput}
                                                                                onChange={e => setFlowIdInput(e.target.value)}
                                                                                onKeyDown={e => e.key === 'Enter' && handleApplyFlowInput()}
                                                                                placeholder={`Flow IDs, e.g. 1,2,5-10  (max ${monitorTotalFlows})`}
                                                                                className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-purple-400 font-mono"
                                                                            />
                                                                            <button
                                                                                onClick={handleApplyFlowInput}
                                                                                disabled={!flowIdInput.trim()}
                                                                                className="text-[11px] px-2.5 py-1 rounded bg-purple-500 text-white font-semibold hover:bg-purple-600 disabled:opacity-40"
                                                                            >Apply</button>
                                                                            <button
                                                                                onClick={handleSelectAllFlows}
                                                                                className="text-[11px] px-2.5 py-1 rounded bg-cyan-500 text-white font-semibold hover:bg-cyan-600"
                                                                                title={monitorTotalFlows > 500 ? 'Limited to first 500 flows' : `Select all ${monitorTotalFlows} flows`}
                                                                            >
                                                                                {monitorTotalFlows > 500 ? 'Select first 500' : 'Select All'}
                                                                            </button>
                                                                            {selectedFlowIds.length > 0 && (
                                                                                <button onClick={handleClearFlows} className="text-[11px] px-2.5 py-1 rounded bg-gray-200 text-gray-600 font-semibold hover:bg-gray-300">Clear</button>
                                                                            )}
                                                                        </div>
                                                                        <p className="text-[10px] text-purple-400">Enter flow IDs separated by commas. Use ranges like <span className="font-mono">1-10</span>. Press Enter or Apply.</p>
                                                                    </div>
                                                                    {/* Table — only when flows are selected and fetched */}
                                                                    {streamStats.length > 0 && (
                                                                        <div className="space-y-1">
                                                                            <div className="flex justify-end gap-1">
                                                                                <button onClick={() => downloadCsv(streamStats, 'stream-statistics.csv', [{ key: 'name', label: 'NAME' }, { key: 'flow-id', label: 'FLOW-ID' }, { key: 'direction', label: 'DIRECTION' }, { key: 'session-id', label: 'SESSION-ID' }, { key: 'tx-pps', label: 'TX(pps)' }, { key: 'tx-bps-l2', label: 'TX(bps)' }, { key: 'rx-pps', label: 'RX(pps)' }, { key: 'rx-bps-l2', label: 'RX(bps)' }, { key: 'rx-loss', label: 'PKT-LOSS' }])} className="text-purple-400 hover:text-purple-600" title="Download CSV"><ArrowDownTrayIcon className="w-3.5 h-3.5" /></button>
                                                                                <button onClick={() => setFullscreenTable('stream')} className="text-purple-400 hover:text-purple-600" title="Fullscreen"><ArrowsPointingOutIcon className="w-3.5 h-3.5" /></button>
                                                                            </div>
                                                                        <div className="overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]">
                                                                            <table className="w-full text-[10px]">
                                                                                <thead>
                                                                                    <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                                                        {['NAME', 'FLOW-ID', 'DIRECTION', 'SESSION-ID', 'TX (pps)', 'TX (bps)', 'RX (pps)', 'RX (bps)', 'PKT-LOSS'].map(h => (
                                                                                            <th key={h} className="text-left py-1.5 px-2 text-purple-600 font-semibold whitespace-nowrap">{h}</th>
                                                                                        ))}
                                                                                    </tr>
                                                                                </thead>
                                                                                <tbody>
                                                                                    {streamStats.map((s, i) => (
                                                                                        <tr key={i} className={`border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] ${s['rx-loss'] > 0 ? 'bg-red-500/10' : ''}`}>
                                                                                            <td className="py-1.5 px-2 font-medium max-w-[100px] truncate" title={s.name}>{s.name}</td>
                                                                                            <td className="py-1.5 px-2">{s['flow-id']}</td>
                                                                                            <td className="py-1.5 px-2">
                                                                                                <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${s.direction === 'upstream' ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'}`}>
                                                                                                    {s.direction === 'upstream' ? '↑ UP' : '↓ DN'}
                                                                                                </span>
                                                                                            </td>
                                                                                            <td className="py-1.5 px-2">{s['session-id'] ?? '—'}</td>
                                                                                            <td className="py-1.5 px-2 text-orange-600 font-bold">{fmtPps(s['tx-pps'])}</td>
                                                                                            <td className="py-1.5 px-2 text-orange-400">{fmtBps(s['tx-bps-l2'])}</td>
                                                                                            <td className="py-1.5 px-2 text-indigo-600 font-bold">{fmtPps(s['rx-pps'])}</td>
                                                                                            <td className="py-1.5 px-2 text-indigo-400">{fmtBps(s['rx-bps-l2'])}</td>
                                                                                            <td className={`py-1.5 px-2 font-bold ${s['rx-loss'] > 0 ? 'text-red-600' : 'text-[var(--text-muted)]'}`}>{s['rx-loss']}</td>
                                                                                        </tr>
                                                                                    ))}
                                                                                </tbody>
                                                                            </table>
                                                                        </div>
                                                                        </div>
                                                                    )}
                                                                    {selectedFlowIds.length > 0 && streamStats.length === 0 && (
                                                                        <p className="text-[10px] text-purple-400 text-center py-1">Loading stream data…</p>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {netStats.length === 0 && accStats.length === 0 && (
                                                                <p className="text-xs text-cyan-400 text-center py-2">Waiting for monitoring data…</p>
                                                            )}

                                                            {/* Log */}
                                                            <div className="flex items-center justify-between gap-2">
                                                                <h5 className="text-xs font-bold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                                                                    <ClipboardDocumentListIcon className="w-3 h-3" />Run Log
                                                                    {logText && logText !== '(empty log)' && (
                                                                        <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full bg-gray-700 text-green-400 font-semibold normal-case">
                                                                            {logText.split('\n').length} lines
                                                                        </span>
                                                                    )}
                                                                </h5>
                                                                <div className="flex items-center gap-1">
                                                                    {logText && logText !== '(empty log)' && (
                                                                        <button
                                                                            onClick={() => {
                                                                                const blob = new Blob([logText], { type: 'text/plain' });
                                                                                const url = URL.createObjectURL(blob);
                                                                                const a = document.createElement('a');
                                                                                a.href = url; a.download = `${inst.name}-run.log`; a.click();
                                                                                URL.revokeObjectURL(url);
                                                                            }}
                                                                            className="btn-secondary text-xs"
                                                                            title="Download run.log"
                                                                        >
                                                                            <ArrowDownTrayIcon className="w-3 h-3" />
                                                                        </button>
                                                                    )}
                                                                    <button onClick={() => fetchLog(inst.name)} disabled={logLoading} className="btn-secondary text-xs disabled:opacity-50">
                                                                        <ArrowPathIcon className={`w-3 h-3 ${logLoading ? 'animate-spin' : ''}`} />
                                                                        {logLoading ? 'Loading…' : 'Fetch Log'}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            {logText && (
                                                                <ResizableEditorBox defaultHeight={240} min={80} max={700}>
                                                                    <pre
                                                                        ref={logPreRef}
                                                                        className="w-full h-full text-[10px] font-mono bg-gray-900 text-green-400 p-3 overflow-auto whitespace-pre-wrap"
                                                                    >
                                                                        {logText}
                                                                    </pre>
                                                                </ResizableEditorBox>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    );
                                })()}
                            </div>

                            {/* ══ BOTTOM: Saved Configs — Start New Test ══ */}
                            <div className="glass-card border-t-2 border-t-emerald-500 overflow-hidden">
                                <div className="px-4 py-3 bg-emerald-500/10 border-b border-emerald-400/30 flex items-center justify-between">
                                    <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                                        <PlayCircleIcon className="w-4 h-4 text-emerald-500" />
                                        <span className="text-emerald-600 dark:text-emerald-400">Saved Configs — Start New Test</span>
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-[var(--text-muted)]">{configs.length} configs</span>
                                        <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden text-[11px] font-semibold">
                                            {([['all', 'All'], ['running', 'Running'], ['idle', 'Idle']] as const).map(([f, label]) => (
                                                <button
                                                    key={f}
                                                    onClick={() => setCfgRunFilter(f)}
                                                    className={`px-2.5 py-1 transition-colors ${
                                                        cfgRunFilter === f
                                                            ? 'bg-cyan-500 text-white'
                                                            : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                                                    }`}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* Search box */}
                                {configs.length > 0 && (
                                    <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-card)]">
                                        <input
                                            type="text"
                                            value={cfgRunSearch}
                                            onChange={e => setCfgRunSearch(e.target.value)}
                                            placeholder="Search configs by name or description…"
                                            className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] focus:outline-none focus:ring-1 focus:ring-cyan-400"
                                        />
                                    </div>
                                )}

                                {configs.filter(c => c.is_owner !== false).length === 0 ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-8">
                                        No configs owned. Go to the Configs tab to create or clone one.
                                    </p>
                                ) : (() => {
                                    const filtered = configs.filter(c => {
                                        // Only own configs can be started
                                        if (c.is_owner === false) return false;
                                        const instName = toInstanceName(c.name);
                                        const inst = allInstances.find(i => i.name === instName);
                                        const isRunning = inst?.status === 'started';
                                        if (cfgRunFilter === 'running' && !isRunning) return false;
                                        if (cfgRunFilter === 'idle' && isRunning) return false;
                                        const q = cfgRunSearch.toLowerCase().trim();
                                        if (q && !c.name.toLowerCase().includes(q) && !(c.description ?? '').toLowerCase().includes(q)) return false;
                                        return true;
                                    });
                                    return filtered.length === 0 ? (
                                        <p className="text-sm text-[var(--text-muted)] text-center py-8">No configs match the filter.</p>
                                    ) : (
                                    <div className="divide-y divide-[var(--border-color)]">
                                        {filtered.map(c => {
                                            const instName = toInstanceName(c.name);
                                            const isStarting = startingConfigId === c.id;
                                            const existingInst = allInstances.find(i => i.name === instName);
                                            const canEditRunCfg = can.editBNGConfig(role, true); // always own in this list
                                            return (
                                                <div key={c.id}>
                                                    <div className="flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors">
                                                        <div className="min-w-0 flex-1 mr-4">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <p className="text-sm font-semibold truncate">{c.name}</p>
                                                                {existingInst && <StatusBadge status={existingInst.status} />}
                                                            </div>
                                                            <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
                                                                instance: <span className="text-cyan-600">{instName}</span>
                                                            </p>
                                                            {c.description && (
                                                                <p className="text-[10px] text-[var(--text-muted)] truncate">{c.description}</p>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                            <button
                                                                onClick={() => setTopologyCfgId(topologyCfgId === c.id ? null : c.id)}
                                                                className={`text-xs px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 transition-colors ${
                                                                    topologyCfgId === c.id ? 'bg-cyan-500/15 text-cyan-700' : 'btn-secondary'
                                                                }`}
                                                                title="Preview topology from config"
                                                            >
                                                                <ShareIcon className="w-3.5 h-3.5" />
                                                                {topologyCfgId === c.id ? 'Hide topo' : 'Topology'}
                                                            </button>
                                                            <button
                                                                onClick={() => setViewingCfgId(viewingCfgId === c.id ? null : c.id)}
                                                                className={`text-xs px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 transition-colors ${
                                                                    viewingCfgId === c.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'btn-secondary'
                                                                }`}
                                                            >
                                                                <DocumentTextIcon className="w-3.5 h-3.5" />
                                                                {viewingCfgId === c.id ? 'Hide' : 'View'}
                                                            </button>
                                                            {canEditRunCfg && (
                                                                <button
                                                                    onClick={() => { setTab('configs'); setCfgSubTab('editor'); setSavedCfgSearch(c.name); startEditConfig(c); }}
                                                                    className="text-xs px-2.5 py-1 rounded-lg btn-secondary font-semibold flex items-center gap-1"
                                                                    title="Open in Config editor"
                                                                >
                                                                    <PencilSquareIcon className="w-3.5 h-3.5" />
                                                                    Edit
                                                                </button>
                                                            )}
                                                            {existingInst?.status === 'started' ? (
                                                                <span className="text-[11px] text-green-600 font-semibold flex items-center gap-1 px-2.5 py-1">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                                                                    Running
                                                                </span>
                                                            ) : (
                                                                <button
                                                                    onClick={() => handleStartFromConfig(c)}
                                                                    disabled={!selServer || isStarting}
                                                                    className="text-xs px-2.5 py-1 rounded-lg bg-green-500 text-white font-semibold hover:bg-green-600 flex items-center gap-1 disabled:opacity-50 transition-colors"
                                                                    title={!selServer ? 'Select a server first' : `Push config + start instance "${instName}"`}
                                                                >
                                                                    <PlayCircleIcon className="w-3.5 h-3.5" />
                                                                    {isStarting ? 'Starting…' : 'Start'}
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Config JSON preview */}
                                                    {viewingCfgId === c.id && (
                                                        <div className="px-4 pb-3 border-t border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                            <p className="text-[10px] text-[var(--text-muted)] py-2 font-semibold uppercase tracking-wide">config.json</p>
                                                            <ResizableEditorBox defaultHeight={192} min={100}>
                                                                <Editor height="100%" theme="vs-dark" language="json"
                                                                    value={JSON.stringify(c.config_json, null, 2)}
                                                                    options={{ readOnly: true, minimap: { enabled: false }, fontSize: 11, scrollBeyondLastLine: false }} />
                                                            </ResizableEditorBox>
                                                        </div>
                                                    )}

                                                    {/* Topology preview */}
                                                    {topologyCfgId === c.id && (
                                                        <div className="px-4 pb-3 border-t border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]">
                                                            <p className="text-[10px] text-[var(--text-muted)] py-2 font-semibold uppercase tracking-wide">Topology preview</p>
                                                            <TopologyView configJson={c.config_json} />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    );
                                })()}
                            </div>

                        </div>
                    )}

                    {/* ══════════════ TAB: REPORTS ══════════════ */}
                    {tab === 'reports' && (
                        <div className="space-y-4">

                            {/* ══ Instances on Server (mirrored from Run tab) ══ */}
                            <div className="glass-card border-t-2 border-t-cyan-500 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-3 bg-cyan-500/10 border-b border-cyan-400/30">
                                    <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                                        <ServerIcon className="w-4 h-4 text-cyan-500" />
                                        <span className="text-cyan-600 dark:text-cyan-400">Instances on Server</span>
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] bg-[var(--bg-primary)] text-[var(--text-muted)] px-2 py-0.5 rounded-full font-bold">
                                            {allInstances.length} total · {allInstances.filter(i => i.status === 'started').length} running
                                        </span>
                                        <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden text-[11px] font-semibold">
                                            {(['running', 'all'] as const).map(f => (
                                                <button key={f} aria-pressed={instFilter === f} onClick={() => setInstFilter(f)}
                                                    className={`px-2.5 py-1 transition-colors ${instFilter === f ? 'bg-cyan-500 text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}>
                                                    {f === 'running' ? 'Running' : 'All'}
                                                </button>
                                            ))}
                                        </div>
                                        <button onClick={() => selServer && loadInstances(selServer)} disabled={!selServer || loadingInstances}
                                            className="btn-secondary text-xs disabled:opacity-50">
                                            <ArrowPathIcon className={`w-3.5 h-3.5 ${loadingInstances ? 'animate-spin' : ''}`} />
                                        </button>
                                    </div>
                                </div>
                                {!selServer ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-6">Select a server in the <strong>Run &amp; Monitor</strong> tab first.</p>
                                ) : loadingInstances ? (
                                    <p className="text-sm text-[var(--text-muted)] text-center py-6">Loading…</p>
                                ) : (() => {
                                    const rptFiltered = allInstances.filter(i => instFilter === 'all' || i.status === 'started');
                                    return rptFiltered.length === 0 ? (
                                        <p className="text-sm text-[var(--text-muted)] text-center py-6">{instFilter === 'running' ? 'No running instances.' : 'No instances.'}</p>
                                    ) : (
                                        <div className="divide-y divide-[var(--border-color)]">
                                            {rptFiltered.map(inst => {
                                                const isRunning = inst.status === 'started';
                                                const isMonitored = activeMonitorInstance === inst.name && monitoring;
                                                const canControl = canControlInstance(inst.name);
                                                const ownerName  = getInstanceOwner(inst.name);
                                                const noPermTitle = ownerName
                                                    ? `Owned by @${ownerName} — no permission`
                                                    : 'No permission to control this instance';
                                                return (
                                                    <div key={inst.name} className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 ${isMonitored ? 'bg-cyan-500/10' : 'hover:bg-[var(--bg-hover)]'} transition-colors`}>
                                                        <div className="flex items-center gap-3 min-w-0">
                                                            <span className="font-mono text-sm font-semibold truncate">{inst.name}</span>
                                                            <StatusBadge status={inst.status} />
                                                            {ownerName && (
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium" title={`Started by @${ownerName}`}>
                                                                    @{ownerName}
                                                                </span>
                                                            )}
                                                            {isMonitored && (
                                                                <span className="flex items-center gap-1 text-[10px] text-cyan-600 font-semibold">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse inline-block" />monitoring
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                            {isRunning && (
                                                                <>
                                                                    <button onClick={() => handleStop(inst.name)}
                                                                        disabled={!canControl || !!instActionLoading[`${inst.name}:stop`] || restartingInstance === inst.name}
                                                                        title={!canControl ? noPermTitle : 'Stop instance'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-amber-500 text-white font-semibold hover:bg-amber-600 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                                                                        <StopCircleIcon className="w-3.5 h-3.5" />
                                                                        {instActionLoading[`${inst.name}:stop`] ? 'Stopping…' : 'Stop'}
                                                                    </button>
                                                                    <button onClick={() => handleRestart(inst.name)}
                                                                        disabled={!canControl || restartingInstance === inst.name || !!instActionLoading[`${inst.name}:stop`]}
                                                                        title={!canControl ? noPermTitle : 'Stop then restart with same config'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                                                                        <ArrowPathRoundedSquareIcon className={`w-3.5 h-3.5 ${restartingInstance === inst.name ? 'animate-spin' : ''}`} />
                                                                        {restartingInstance === inst.name ? 'Restarting…' : 'Restart'}
                                                                    </button>
                                                                    <button onClick={() => handleKill(inst.name)}
                                                                        disabled={!canControl || !!instActionLoading[`${inst.name}:kill`]}
                                                                        title={!canControl ? noPermTitle : 'Force kill instance'}
                                                                        className="text-xs px-2.5 py-1 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-600 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                                                                        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                                                                        {instActionLoading[`${inst.name}:kill`] ? 'Killing…' : 'Kill'}
                                                                    </button>
                                                                    <button onClick={() => { toggleMonitor(inst.name); setTab('run'); }}
                                                                        className={`text-xs px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 transition-colors ${isMonitored ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/25' : 'bg-cyan-500 text-white hover:bg-cyan-600'}`}
                                                                        title="Switch to Run & Monitor tab to view live stats">
                                                                        <BoltIcon className="w-3.5 h-3.5" />
                                                                        {isMonitored ? 'Stop Monitor' : 'Monitor'}
                                                                    </button>
                                                                </>
                                                            )}
                                                            {/* Fetch report for this instance directly */}
                                                            <button
                                                                onClick={async () => { const srv = rptServer ?? selServer; if (srv) { await loadRptInstances(srv); setRptInstance(inst.name); } }}
                                                                className="text-xs px-2.5 py-1 rounded-lg btn-secondary font-semibold flex items-center gap-1"
                                                                title="Fetch report for this instance"
                                                            >
                                                                <ChartBarIcon className="w-3.5 h-3.5" />Report
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* ══ Fetch Report ══ */}
                            <div className="glass-card p-4 space-y-3">
                                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Fetch Report</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">BNG Server</label>
                                        <select className="input-field text-sm" value={rptServer?.id ?? ''}
                                            onChange={e => {
                                                const s = servers.find(x => x.id === Number(e.target.value)) || null;
                                                if (s) loadRptInstances(s);
                                                else { setRptServer(null); setRptInstances([]); }
                                            }}>
                                            <option value="">Select server…</option>
                                            {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs text-[var(--text-muted)] mb-1">Instance</label>
                                        <select className="input-field text-sm" value={rptInstance} onChange={e => setRptInstance(e.target.value)} disabled={!rptServer}>
                                            <option value="">Select instance…</option>
                                            {rptInstances.map(i => <option key={i} value={i}>{i}</option>)}
                                        </select>
                                    </div>
                                    <button onClick={fetchReport} disabled={!rptInstance || rptLoading} className="btn-primary text-sm disabled:opacity-50">
                                        {rptLoading ? 'Loading…' : 'Fetch Report'}
                                    </button>
                                </div>
                                {rptError && <p className="text-xs text-red-500 flex items-center gap-1"><ExclamationTriangleIcon className="w-3.5 h-3.5" />{rptError}</p>}
                            </div>

                            {report && <ReportDashboard report={report} instanceName={rptInstance} onDownload={downloadReport} />}
                        </div>
                    )}

                </div>
            </div>

        {/* ── Fullscreen Table Modal (portal → bypasses stacking context) ── */}
        {fullscreenTable && createPortal(
            <div className="fixed inset-0 z-[9999] bg-black/60 flex items-start justify-center p-4 overflow-auto" onClick={() => setFullscreenTable(null)}>
                <div className="bg-[var(--bg-card)] rounded-xl shadow-2xl w-full max-w-7xl mt-8" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
                        <h3 className="text-sm font-bold text-[var(--text-primary)]">
                            {fullscreenTable === 'network' ? 'Network Interfaces' : fullscreenTable === 'access' ? 'Access Interfaces' : 'Stream Statistics'}
                        </h3>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => downloadCsv(
                                    fullscreenTable === 'network' ? netStats : fullscreenTable === 'access' ? accStats : streamStats,
                                    `${fullscreenTable}-table.csv`,
                                    fullscreenTable === 'network'
                                        ? [{ key: 'name', label: 'Interface' }, { key: 'tx-pps', label: 'NW-TX(pps)' }, { key: 'rx-pps', label: 'NW-RX(pps)' }, { key: 'rx-loss-packets-streams', label: 'NW-LOSS(pkts-stream)' }]
                                        : fullscreenTable === 'access'
                                        ? [{ key: 'name', label: 'Interface' }, { key: 'tx-pps', label: 'AC-TX(pps)' }, { key: 'rx-pps', label: 'AC-RX(pps)' }, { key: 'rx-loss-packets-streams', label: 'AC-LOSS(stream)' }, { key: 'rx-loss-packets-multicast', label: 'AC-LOSS(mcast)' }]
                                        : [{ key: 'name', label: 'NAME' }, { key: 'flow-id', label: 'FLOW-ID' }, { key: 'direction', label: 'DIRECTION' }, { key: 'session-id', label: 'SESSION-ID' }, { key: 'tx-pps', label: 'TX(pps)' }, { key: 'tx-bps-l2', label: 'TX(bps)' }, { key: 'rx-pps', label: 'RX(pps)' }, { key: 'rx-bps-l2', label: 'RX(bps)' }, { key: 'rx-loss', label: 'PKT-LOSS' }]
                                )}
                                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                title="Download CSV"
                            >
                                <ArrowDownTrayIcon className="w-4 h-4" />
                            </button>
                            <button onClick={() => setFullscreenTable(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Close">
                                <XMarkIcon className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                    <div className="overflow-auto max-h-[80vh] p-4">
                        {fullscreenTable === 'network' && (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                        {['Interface', 'NW-TX (pps)', 'NW-RX (pps)', 'NW-LOSS (pkts-stream)'].map(h => (
                                            <th key={h} className="text-left py-2 px-3 text-indigo-600 font-semibold whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {netStats.map((iif, i) => (
                                        <tr key={i} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]">
                                            <td className="py-2 px-3 font-mono">{iif.name}</td>
                                            <td className="py-2 px-3 text-orange-600 font-bold">{fmtPps(iif['tx-pps'])}</td>
                                            <td className="py-2 px-3 text-indigo-600 font-bold">{fmtPps(iif['rx-pps'])}</td>
                                            <td className={`py-2 px-3 font-bold ${iif['rx-loss-packets-streams'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-streams']}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {fullscreenTable === 'access' && (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                        {['Interface', 'AC-TX (pps)', 'AC-RX (pps)', 'AC-LOSS (stream)', 'AC-LOSS (mcast)'].map(h => (
                                            <th key={h} className="text-left py-2 px-3 text-blue-600 font-semibold whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {accStats.map((iif, i) => (
                                        <tr key={i} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]">
                                            <td className="py-2 px-3 font-mono">{iif.name}</td>
                                            <td className="py-2 px-3 text-orange-600 font-bold">{fmtPps(iif['tx-pps'])}</td>
                                            <td className="py-2 px-3 text-blue-600 font-bold">{fmtPps(iif['rx-pps'])}</td>
                                            <td className={`py-2 px-3 font-bold ${iif['rx-loss-packets-streams'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-streams']}</td>
                                            <td className={`py-2 px-3 font-bold ${iif['rx-loss-packets-multicast'] > 0 ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>{iif['rx-loss-packets-multicast']}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {fullscreenTable === 'stream' && (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]">
                                        {['NAME', 'FLOW-ID', 'DIRECTION', 'SESSION-ID', 'TX (pps)', 'TX (bps)', 'RX (pps)', 'RX (bps)', 'PKT-LOSS'].map(h => (
                                            <th key={h} className="text-left py-2 px-3 text-purple-600 font-semibold whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {streamStats.map((s, i) => (
                                        <tr key={i} className={`border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] ${s['rx-loss'] > 0 ? 'bg-red-500/10' : ''}`}>
                                            <td className="py-2 px-3 font-medium">{s.name}</td>
                                            <td className="py-2 px-3">{s['flow-id']}</td>
                                            <td className="py-2 px-3">
                                                <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${s.direction === 'upstream' ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'}`}>
                                                    {s.direction === 'upstream' ? '↑ UP' : '↓ DN'}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3">{s['session-id'] ?? '—'}</td>
                                            <td className="py-2 px-3 text-orange-600 font-bold">{fmtPps(s['tx-pps'])}</td>
                                            <td className="py-2 px-3 text-orange-400">{fmtBps(s['tx-bps-l2'])}</td>
                                            <td className="py-2 px-3 text-indigo-600 font-bold">{fmtPps(s['rx-pps'])}</td>
                                            <td className="py-2 px-3 text-indigo-400">{fmtBps(s['rx-bps-l2'])}</td>
                                            <td className={`py-2 px-3 font-bold ${s['rx-loss'] > 0 ? 'text-red-600' : 'text-[var(--text-muted)]'}`}>{s['rx-loss']}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        , document.body)}

        {/* Topology preview modal (from Configs tab) */}
        {topologyModalCfg && createPortal(
            <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setTopologyModalCfg(null)}>
                <div className="bg-[var(--bg-secondary)] rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] font-semibold">Topology preview</div>
                            <h3 className="text-lg font-bold text-[var(--text-primary)]">{topologyModalCfg.name}</h3>
                        </div>
                        <button onClick={() => setTopologyModalCfg(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-2">
                            <XMarkIcon className="w-5 h-5" />
                        </button>
                    </div>
                    <TopologyView configJson={topologyModalCfg.config_json} />
                </div>
            </div>,
            document.body,
        )}
        </div>
    );
}

// ── Report Dashboard ─────────────────────────────────────────────────────────

// Section accent colour palette — cycles by index
const RPT_SECTION_COLORS = [
    { border: 'border-indigo-400/60',  headerBg: 'bg-indigo-500/10',  text: 'text-indigo-600' },
    { border: 'border-emerald-400/60', headerBg: 'bg-emerald-500/10', text: 'text-emerald-600' },
    { border: 'border-violet-400/60',  headerBg: 'bg-violet-500/10',  text: 'text-violet-600'  },
    { border: 'border-amber-400/60',   headerBg: 'bg-amber-500/10',   text: 'text-amber-600'   },
    { border: 'border-cyan-400/60',    headerBg: 'bg-cyan-500/10',    text: 'text-cyan-600'    },
    { border: 'border-rose-400/60',    headerBg: 'bg-rose-500/10',    text: 'text-rose-600'    },
] as const;

function rptLabelify(key: string) {
    return key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function rptFmt(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return v.toLocaleString();
    return String(v);
}
// Colour-code metric values: red for loss/error/fail, green for success/ok, blue for tx, teal for rx
function rptMetricColor(key: string, value: unknown): string {
    const k = key.toLowerCase();
    if (k.includes('loss') || k.includes('fail') || k.includes('error') || k.includes('drop')) {
        return typeof value === 'number' && value > 0 ? 'text-red-500' : 'text-emerald-500';
    }
    if (k.includes('establish') || k.includes('success') || k === 'ok') return 'text-emerald-500';
    if (k.includes('tx') || k.includes('transmit') || k.includes('sent')) return 'text-blue-500';
    if (k.includes('rx') || k.includes('receiv')) return 'text-teal-500';
    if (k.includes('rate') || k.includes('bps') || k.includes('speed')) return 'text-purple-500';
    if (k.includes('session') || k.includes('stream')) return 'text-indigo-500';
    return 'text-[var(--text-primary)]';
}
type RptKind = 'scalar' | 'dict-of-scalars' | 'dict-of-dicts' | 'dict-mixed' | 'list-of-dicts' | 'list-of-scalars' | 'other';
function rptKind(v: unknown): RptKind {
    if (v === null || v === undefined || typeof v !== 'object') return 'scalar';
    if (Array.isArray(v)) {
        if (v.length === 0) return 'list-of-scalars';
        if (v.every(i => i !== null && typeof i === 'object' && !Array.isArray(i))) return 'list-of-dicts';
        if (v.every(i => i === null || typeof i !== 'object')) return 'list-of-scalars';
        return 'other';
    }
    const entries = Object.entries(v as object);
    if (entries.length === 0) return 'dict-of-scalars';
    if (entries.every(([, val]) => val === null || typeof val !== 'object')) return 'dict-of-scalars';
    if (entries.every(([, val]) => val !== null && typeof val === 'object' && !Array.isArray(val))) return 'dict-of-dicts';
    return 'dict-mixed';
}

// Stat card grid — for dict-of-scalars
function RptStatGrid({ entries }: { entries: [string, unknown][] }) {
    return (
        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {entries.map(([key, value]) => (
                <div key={key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-3 space-y-1 shadow-sm">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] leading-tight">{rptLabelify(key)}</p>
                    <p className={`text-xl font-bold leading-tight ${rptMetricColor(key, value)}`}>{rptFmt(value)}</p>
                </div>
            ))}
        </div>
    );
}

// Structured table — for dict-of-dicts (Name column + sub-field columns)
function RptDictOfDictsTable({ entries }: { entries: [string, unknown][] }) {
    const allSubKeys = Array.from(new Set(
        entries.flatMap(([, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v as object) : [])
    ));
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                        <th className="text-left px-4 py-2.5 font-semibold text-[var(--text-muted)] whitespace-nowrap">Name</th>
                        {allSubKeys.map(k => (
                            <th key={k} className="text-left px-3 py-2.5 font-semibold text-[var(--text-muted)] whitespace-nowrap">{rptLabelify(k)}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {entries.map(([name, vals], i) => (
                        <tr key={name} className={`border-b border-[var(--border-color)] ${i % 2 !== 0 ? 'bg-[var(--bg-hover)]' : ''} hover:bg-[var(--bg-hover)] transition-colors`}>
                            <td className="px-4 py-2.5 font-mono font-semibold text-[var(--text-primary)] whitespace-nowrap">{name}</td>
                            {allSubKeys.map(k => {
                                const cell = (vals !== null && typeof vals === 'object' && !Array.isArray(vals)) ? (vals as any)[k] : undefined;
                                return (
                                    <td key={k} className={`px-3 py-2.5 font-mono ${rptMetricColor(k, cell)}`}>{rptFmt(cell)}</td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// Mixed dict — scalars render as 2-col rows; nested complex values get their own sub-section
function RptKVTable({ entries }: { entries: [string, unknown][] }) {
    return (
        <div className="divide-y divide-[var(--border-color)]">
            {entries.map(([k, v]) => {
                const kind = rptKind(v);

                if (kind === 'list-of-dicts') {
                    return (
                        <div key={k}>
                            <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--bg-hover)]">
                                {rptLabelify(k)}
                                <span className="ml-1.5 font-normal normal-case opacity-70">({(v as unknown[]).length} items)</span>
                            </p>
                            <RptListTable items={v as Record<string, unknown>[]} />
                        </div>
                    );
                }
                if (kind === 'dict-of-dicts') {
                    return (
                        <div key={k}>
                            <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--bg-hover)]">
                                {rptLabelify(k)}
                            </p>
                            <RptDictOfDictsTable entries={Object.entries(v as object)} />
                        </div>
                    );
                }
                if (kind === 'dict-of-scalars') {
                    return (
                        <div key={k}>
                            <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--bg-hover)]">
                                {rptLabelify(k)}
                            </p>
                            <RptStatGrid entries={Object.entries(v as object)} />
                        </div>
                    );
                }
                if (kind === 'list-of-scalars') {
                    return (
                        <div key={k} className="flex items-start gap-4 px-4 py-2.5 text-xs hover:bg-[var(--bg-hover)] transition-colors">
                            <span className="font-medium text-[var(--text-muted)] whitespace-nowrap capitalize shrink-0 w-2/5">{rptLabelify(k)}</span>
                            <div className="flex flex-wrap gap-1.5">
                                {(v as unknown[]).map((item, i) => (
                                    <span key={i} className="px-2 py-0.5 rounded bg-[var(--bg-hover)] border border-[var(--border-color)] font-mono text-[var(--text-primary)]">{rptFmt(item)}</span>
                                ))}
                            </div>
                        </div>
                    );
                }
                // scalar / fallback
                return (
                    <div key={k} className="flex items-baseline gap-4 px-4 py-2.5 text-xs hover:bg-[var(--bg-hover)] transition-colors">
                        <span className="font-medium text-[var(--text-muted)] whitespace-nowrap capitalize shrink-0 w-2/5">{rptLabelify(k)}</span>
                        <span className={`font-mono font-semibold ${rptMetricColor(k, v)}`}>
                            {typeof v === 'object' ? JSON.stringify(v) : rptFmt(v)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// Table for list-of-dicts
function RptListTable({ items }: { items: Record<string, unknown>[] }) {
    const allKeys = Array.from(new Set(items.flatMap(item => Object.keys(item))));
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                        {allKeys.map(k => (
                            <th key={k} className="text-left px-3 py-2.5 font-semibold text-[var(--text-muted)] whitespace-nowrap">{rptLabelify(k)}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {items.map((item, i) => (
                        <tr key={i} className={`border-b border-[var(--border-color)] ${i % 2 !== 0 ? 'bg-[var(--bg-hover)]' : ''} hover:bg-[var(--bg-hover)] transition-colors`}>
                            {allKeys.map(k => (
                                <td key={k} className={`px-3 py-2.5 font-mono ${rptMetricColor(k, item[k])}`}>{rptFmt(item[k])}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// Section card — wraps content with colored border + collapsible header
function RptSectionCard({ title, data, colorIdx }: { title: string; data: unknown; colorIdx: number }) {
    const [open, setOpen] = useState(true);
    const c = RPT_SECTION_COLORS[colorIdx % RPT_SECTION_COLORS.length];
    const kind = rptKind(data);

    const renderBody = () => {
        if (kind === 'scalar') {
            return (
                <div className="px-5 py-4">
                    <p className={`text-2xl font-bold ${rptMetricColor(title, data)}`}>{rptFmt(data)}</p>
                </div>
            );
        }
        if (kind === 'dict-of-scalars') {
            return <RptStatGrid entries={Object.entries(data as object)} />;
        }
        if (kind === 'dict-of-dicts') {
            return <RptDictOfDictsTable entries={Object.entries(data as object)} />;
        }
        if (kind === 'dict-mixed') {
            return <RptKVTable entries={Object.entries(data as object)} />;
        }
        if (kind === 'list-of-dicts') {
            return <RptListTable items={data as Record<string, unknown>[]} />;
        }
        if (kind === 'list-of-scalars') {
            return (
                <div className="px-5 py-3 flex flex-wrap gap-2">
                    {(data as unknown[]).map((v, i) => (
                        <span key={i} className="px-2.5 py-1 rounded-lg bg-[var(--bg-hover)] text-[var(--text-primary)] text-xs font-mono">{rptFmt(v)}</span>
                    ))}
                </div>
            );
        }
        // Fallback
        return (
            <pre className="px-5 py-3 text-xs text-[var(--text-secondary)] overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(data, null, 2)}
            </pre>
        );
    };

    const countBadge = () => {
        if (Array.isArray(data)) return data.length;
        if (data !== null && typeof data === 'object') return Object.keys(data as object).length;
        return null;
    };
    const badge = countBadge();

    return (
        <div className={`border-2 ${c.border} rounded-xl overflow-hidden`}>
            <button
                onClick={() => setOpen(o => !o)}
                className={`w-full flex items-center justify-between px-4 py-2.5 ${c.headerBg} border-b border-[var(--border-color)] hover:opacity-90 transition-opacity`}>
                <div className="flex items-center gap-2">
                    <span className={`text-sm font-bold capitalize ${c.text}`}>{rptLabelify(title)}</span>
                    {badge !== null && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.headerBg} ${c.text} border ${c.border} font-bold`}>{badge}</span>
                    )}
                </div>
                <span className="text-[var(--text-muted)] text-[10px] font-bold">{open ? '▲' : '▼'}</span>
            </button>
            {open && renderBody()}
        </div>
    );
}

function ReportDashboard({ report, instanceName, onDownload }: { report: any; instanceName: string; onDownload: () => void }) {
    const version = report.version?.report ?? report.version;
    const sections = Object.entries(report as Record<string, unknown>).filter(([k]) => k !== 'version');

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-cyan-500/10 flex items-center justify-center shrink-0">
                        <ChartBarIcon className="w-5 h-5 text-cyan-500" />
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-[var(--text-primary)]">{instanceName}</h3>
                        {version && (
                            <p className="text-xs text-[var(--text-muted)]">
                                BNGBlaster {typeof version === 'object' ? JSON.stringify(version) : version}
                            </p>
                        )}
                    </div>
                </div>
                <button onClick={onDownload} className="btn-secondary text-sm">
                    <ArrowDownTrayIcon className="w-4 h-4" />Download JSON
                </button>
            </div>

            {/* Section cards */}
            {sections.map(([section, rawData], idx) => {
                // Unwrap BNGBlaster's .report wrapper if present
                const data = (rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData) && 'report' in (rawData as object))
                    ? (rawData as any).report
                    : rawData;
                if (data === null || data === undefined) return null;
                return <RptSectionCard key={section} title={section} data={data} colorIdx={idx} />;
            })}
        </div>
    );
}
