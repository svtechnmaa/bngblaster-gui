import { useMemo, useState } from 'react';
import {
    parseTopology, protocolSummary,
    NETWORK_SIDE_PROTOCOLS, ACCESS_SIDE_PROTOCOLS, LINK_PROTOCOLS,
    type Topology, type NetworkIface, type AccessIface,
} from '../../utils/topologyParser';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatIface(i: NetworkIface | AccessIface): string {
    return i.interface ?? '(no iface)';
}

function vlanRange(a: AccessIface): string | null {
    const o1 = a['outer-vlan-min'];
    const o2 = a['outer-vlan-max'];
    if (o1 === undefined && o2 === undefined) return null;
    if (o1 !== undefined && o2 !== undefined && o1 !== o2) return `vlan ${o1}-${o2}`;
    return `vlan ${o1 ?? o2}`;
}

function Chip({ label, onClick, active, color = 'cyan' }: {
    label: string; onClick?: () => void; active?: boolean;
    color?: 'cyan' | 'purple' | 'green' | 'orange' | 'pink';
}) {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border cursor-pointer transition-colors';
    const colorMap = {
        cyan:   active ? 'bg-cyan-600 text-white border-cyan-600'     : 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100',
        purple: active ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100',
        green:  active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
        orange: active ? 'bg-orange-600 text-white border-orange-600' : 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
        pink:   active ? 'bg-pink-600 text-white border-pink-600'     : 'bg-pink-50 text-pink-700 border-pink-200 hover:bg-pink-100',
    };
    return (
        <button type="button" onClick={onClick} className={`${base} ${colorMap[color]}`}>
            {label}
        </button>
    );
}

// ── Protocol detail renderer ─────────────────────────────────────────────────

function KV({ k, v }: { k: string; v: unknown }) {
    if (v === undefined || v === null || v === '') return null;
    let rendered: React.ReactNode;
    if (typeof v === 'object') rendered = <pre className="text-xs whitespace-pre-wrap break-all m-0">{JSON.stringify(v, null, 2)}</pre>;
    else rendered = <span className="text-xs break-all">{String(v)}</span>;
    return (
        <div className="flex gap-2 py-0.5">
            <span className="text-xs font-medium text-[var(--text-muted)] min-w-[140px]">{k}</span>
            {rendered}
        </div>
    );
}

function ProtocolDetail({ name, data }: { name: string; data: unknown }) {
    const items = Array.isArray(data) ? data : [data];
    return (
        <div className="space-y-3">
            {items.map((item, idx) => (
                <div key={idx} className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-primary)]">
                    {items.length > 1 && (
                        <div className="text-xs font-semibold text-[var(--text-primary)] mb-2">{name} #{idx + 1}</div>
                    )}
                    {item && typeof item === 'object'
                        ? Object.entries(item as Record<string, unknown>).map(([k, v]) => <KV key={k} k={k} v={v} />)
                        : <div className="text-xs text-[var(--text-muted)]">{String(item)}</div>}
                </div>
            ))}
        </div>
    );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function TopologyView({ configJson }: { configJson: unknown }) {
    const topo: Topology = useMemo(() => parseTopology(configJson), [configJson]);
    const [selected, setSelected] = useState<string | null>(null);

    const netProtos = NETWORK_SIDE_PROTOCOLS.filter(k => topo.protocols[k]);
    const accProtos = ACCESS_SIDE_PROTOCOLS.filter(k => topo.protocols[k]);
    const linkProtos = LINK_PROTOCOLS.filter(k => topo.protocols[k]);

    const sessionCount = (topo.sessions?.count as number | undefined);
    const streamCount = topo.streams?.length ?? 0;

    const toggle = (key: string) => setSelected(s => s === key ? null : key);

    const renderNode = (
        side: 'network' | 'access',
        ifaces: (NetworkIface | AccessIface)[],
        protos: readonly string[],
        color: 'cyan' | 'purple',
    ) => (
        <div className="flex-1 min-w-0 border-2 border-[var(--border-color)] rounded-xl bg-[var(--bg-secondary)] p-4 shadow-[var(--shadow-sm)]">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] font-semibold">BNGBlaster</div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">{side === 'network' ? 'Network side' : 'Access side'}</div>
                </div>
                <span className={`w-3 h-3 rounded-full ${side === 'network' ? 'bg-cyan-500' : 'bg-purple-500'}`} />
            </div>

            {ifaces.length === 0 ? (
                <div className="text-xs text-[var(--text-muted)] italic">No {side} interfaces</div>
            ) : (
                <div className="space-y-2 mb-3">
                    {ifaces.map((i, idx) => (
                        <div key={idx} className="text-xs bg-[var(--bg-primary)] rounded px-2 py-1.5 border border-[var(--border-color)]">
                            <div className="font-mono font-semibold text-[var(--text-primary)]">{formatIface(i)}</div>
                            {i.address && <div className="text-[var(--text-muted)]">{i.address}{i.gateway ? ` → ${i.gateway}` : ''}</div>}
                            {side === 'access' && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {(i as AccessIface).type && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-medium">{(i as AccessIface).type}</span>}
                                    {vlanRange(i as AccessIface) && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">{vlanRange(i as AccessIface)}</span>}
                                    {(i as AccessIface)['vlan-mode'] && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">{(i as AccessIface)['vlan-mode']}</span>}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {protos.length > 0 && (
                <>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-semibold mb-1">Protocols</div>
                    <div className="flex flex-wrap gap-1">
                        {protos.map(k => {
                            const summary = protocolSummary(k, topo.protocols[k as keyof typeof topo.protocols]);
                            return (
                                <Chip
                                    key={k}
                                    label={`${k.toUpperCase()}${summary ? ` · ${summary}` : ''}`}
                                    onClick={() => toggle(k)}
                                    active={selected === k}
                                    color={color}
                                />
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );

    return (
        <div className="space-y-4 max-w-5xl mx-auto">
            {/* Topology diagram */}
            <div className="flex items-stretch gap-2">
                {renderNode('network', topo.network, netProtos, 'cyan')}

                {/* Link + DUT */}
                <div className="flex flex-col items-center justify-center min-w-[180px]">
                    <div className="border-2 border-dashed border-[var(--text-muted)] rounded-xl bg-[var(--bg-primary)] px-4 py-3 text-center">
                        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] font-semibold">Device Under Test</div>
                        <div className="text-lg font-bold text-[var(--text-primary)]">DUT</div>
                    </div>
                    <div className="mt-2 space-y-1 text-center">
                        {sessionCount !== undefined && (
                            <Chip label={`Sessions: ${sessionCount}`} onClick={() => toggle('sessions')} active={selected === 'sessions'} color="orange" />
                        )}
                        {streamCount > 0 && (
                            <div><Chip label={`Streams: ${streamCount}`} onClick={() => toggle('streams')} active={selected === 'streams'} color="green" /></div>
                        )}
                        {topo['session-traffic'] && (
                            <div><Chip label="Session traffic" onClick={() => toggle('session-traffic')} active={selected === 'session-traffic'} color="green" /></div>
                        )}
                        {topo.traffic && (
                            <div><Chip label="Traffic cfg" onClick={() => toggle('traffic')} active={selected === 'traffic'} color="green" /></div>
                        )}
                        {linkProtos.map(k => (
                            <div key={k}><Chip label={`${k} · ${protocolSummary(k, topo.protocols[k as keyof typeof topo.protocols])}`} onClick={() => toggle(k)} active={selected === k} color="pink" /></div>
                        ))}
                    </div>
                </div>

                {renderNode('access', topo.access, accProtos, 'purple')}
            </div>

            {/* Expanded detail */}
            {selected && (
                <div className="border border-[var(--border-color)] rounded-xl bg-[var(--bg-secondary)] p-4 shadow-[var(--shadow-sm)]">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                            {selected.toUpperCase()} — details
                        </h4>
                        <button type="button" onClick={() => setSelected(null)} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Close ✕</button>
                    </div>
                    <ProtocolDetail
                        name={selected}
                        data={
                            selected === 'sessions' ? topo.sessions :
                            selected === 'streams' ? topo.streams :
                            selected === 'session-traffic' ? topo['session-traffic'] :
                            selected === 'traffic' ? topo.traffic :
                            topo.protocols[selected as keyof typeof topo.protocols]
                        }
                    />
                </div>
            )}

            {/* Empty state */}
            {topo.network.length === 0 && topo.access.length === 0 && (
                <div className="text-center text-sm text-[var(--text-muted)] py-6 border border-dashed border-[var(--border-color)] rounded-xl">
                    No interfaces defined in this config.
                </div>
            )}
        </div>
    );
}
