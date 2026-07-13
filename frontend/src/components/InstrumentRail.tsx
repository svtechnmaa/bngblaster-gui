/** Inline telemetry readouts for the TopBar (next to the brand).
 *
 * No box/faceplate — the stats sit directly on the top bar surface and blend
 * with the theme: a status LED, monospace controller/instance readouts, live
 * TX/RX (warm/cool) and a LIVE/IDLE pill. Readouts collapse by breakpoint; the
 * pill always stays. Motion gated by prefers-reduced-motion.
 */

import { useTelemetryStore } from '../store/useTelemetryStore';

function fmtPps(n: number) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}

function fmtBps(n: number) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}

function Stat({ label, value, unit, tone, className = '' }: { label: string; value: string; unit?: string; tone?: 'tx' | 'rx'; className?: string }) {
    const color = tone === 'tx'
        ? 'text-orange-600 dark:text-orange-400'
        : tone === 'rx'
        ? 'text-cyan-600 dark:text-cyan-400'
        : 'text-[var(--text-primary)]';
    return (
        <span className={`items-baseline gap-1 whitespace-nowrap shrink-0 ${className}`}>
            <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</span>
            <span className={`font-mono tabular-nums text-xs font-semibold ${color}`}>{value}{unit && <span className="text-[9px] font-medium text-[var(--text-muted)] ml-0.5">{unit}</span>}</span>
        </span>
    );
}

export default function InstrumentRail() {
    const t = useTelemetryStore((s) => s.telemetry);
    const state = t.monitoring ? 'Live' : t.running > 0 ? 'Running' : 'Idle';
    const idle = state === 'Idle';

    return (
        <div
            role="status"
            aria-label={`Controller ${t.server ? t.server.name : 'none'}, ${t.running} of ${t.total} instances running, ${state}`}
            className="flex items-center gap-3 min-w-0"
        >
            {/* Controller link — LED always visible; name from sm up */}
            <span className="flex items-center gap-1.5 min-w-0" title={t.server ? `${t.server.host}:${t.server.port}` : 'No server selected'}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${t.server ? 'bg-emerald-500 shadow-[0_0_6px_1px_rgba(16,185,129,0.7)]' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <span className="hidden sm:block min-w-0 max-w-[10rem] font-mono text-xs text-[var(--text-primary)] truncate">{t.server ? t.server.name : 'No server'}</span>
                {t.server && <span className="hidden md:inline font-mono text-[10px] text-[var(--text-muted)] shrink-0">:{t.server.port}</span>}
            </span>

            <Stat className="flex" label="Inst" value={`${t.running}/${t.total}`} />
            {t.hasLive && <Stat className="hidden lg:flex" label="TX" value={fmtBps(t.txBps)} unit="bps" tone="tx" />}
            {t.hasLive && <Stat className="hidden lg:flex" label="RX" value={fmtBps(t.rxBps)} unit="bps" tone="rx" />}
            {t.hasLive && <Stat className="hidden xl:flex" label="TX" value={fmtPps(t.txPps)} unit="pps" tone="tx" />}
            {t.hasLive && <Stat className="hidden xl:flex" label="Flows" value={t.streams.toLocaleString()} />}
            {t.hasLive && (
                <span className="hidden md:flex items-baseline gap-1 whitespace-nowrap shrink-0">
                    <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">Loss</span>
                    <span className={`font-mono tabular-nums text-xs font-semibold ${t.loss > 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>{t.loss.toLocaleString()}</span>
                </span>
            )}

            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-[0.14em] border whitespace-nowrap shrink-0 ${
                idle
                    ? 'bg-slate-400/12 text-slate-500 dark:text-slate-300 border-slate-400/25'
                    : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-400/40'
            }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${idle ? 'bg-slate-400' : 'bg-emerald-500 motion-safe:animate-pulse'}`} />
                {state}
            </span>
        </div>
    );
}
