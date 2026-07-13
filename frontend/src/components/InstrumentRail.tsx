/** Instrument status rail — a measurement-instrument faceplate for the TopBar.
 *
 * LED link/traffic lamps + live monospace telemetry (controller, instances,
 * TX/RX pps, LIVE/IDLE). Theme-aware via the `.instrument-rail` tokens in
 * index.css (light faceplate in light mode, dark faceplate in dark). Readouts
 * collapse from the right as width shrinks; LEDs + state pill always show.
 * Motion is gated by prefers-reduced-motion.
 */

import { useTelemetryStore } from '../store/useTelemetryStore';

function fmtPps(n: number) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}

function Led({ on, pulse = false, label }: { on: boolean; pulse?: boolean; label: string }) {
    return (
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--ir-label)' }}>
            <span
                className={`w-2 h-2 rounded-full ${pulse ? 'motion-safe:animate-pulse' : ''}`}
                style={{
                    background: on ? '#34d399' : 'var(--ir-led-off)',
                    boxShadow: on ? '0 0 7px 1px rgba(52,211,153,0.85)' : 'inset 0 0 0 1px rgba(128,128,128,0.25)',
                }}
            />
            {label}
        </div>
    );
}

function Readout({ label, value, unit, tone, title, className = '' }: {
    label: string; value: string; unit?: string; tone?: 'tx' | 'rx'; title?: string; className?: string;
}) {
    const color = tone === 'tx' ? 'var(--ir-tx)' : tone === 'rx' ? 'var(--ir-rx)' : 'var(--ir-value)';
    return (
        <div
            className={`flex-col justify-center gap-0.5 px-3.5 py-1.5 whitespace-nowrap border-l ${className}`}
            style={{ borderColor: 'var(--ir-divider)' }}
            title={title}
        >
            <span className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ir-label)' }}>{label}</span>
            <span className="flex items-baseline gap-1 font-mono tabular-nums text-[13px] font-semibold leading-none" style={{ color }}>
                {value}{unit && <span className="text-[9px] font-semibold" style={{ color: 'var(--ir-unit)' }}>{unit}</span>}
            </span>
        </div>
    );
}

export default function InstrumentRail() {
    const t = useTelemetryStore((s) => s.telemetry);
    const state = t.monitoring ? 'Live' : t.running > 0 ? 'Running' : 'Idle';
    const idle = state === 'Idle';

    return (
        <div
            role="status"
            aria-label={`Instrument status: controller ${t.server ? t.server.name : 'none'}, ${t.running} of ${t.total} instances running, ${state}`}
            className="instrument-rail flex items-stretch rounded-lg overflow-x-auto max-w-full"
        >
            <div className="flex flex-col justify-center gap-1 px-3 py-1.5">
                <Led on={!!t.server} label="Ctrl" />
                <Led on={t.running > 0} pulse={t.running > 0} label="Traffic" />
            </div>
            <Readout className="hidden lg:flex" label="Controller" value={t.server ? t.server.name : '—'} unit={t.server ? `:${t.server.port}` : undefined} title={t.server ? `${t.server.host}:${t.server.port}` : 'No server selected'} />
            <Readout className="hidden sm:flex" label="Instances" value={String(t.running)} unit={`/ ${t.total} up`} />
            <Readout className="hidden xl:flex" label="TX rate" value={t.hasLive ? fmtPps(t.txPps) : '—'} unit="pps" tone="tx" />
            <Readout className="hidden xl:flex" label="RX rate" value={t.hasLive ? fmtPps(t.rxPps) : '—'} unit="pps" tone="rx" />
            <div className="flex items-center px-3 border-l" style={{ borderColor: 'var(--ir-divider)' }}>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-extrabold uppercase tracking-[0.14em] border ${
                    idle
                        ? 'bg-slate-400/15 text-slate-500 dark:text-slate-300 border-slate-400/30'
                        : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-400/40'
                }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${idle ? 'bg-slate-400' : 'bg-emerald-400 motion-safe:animate-pulse'}`} />
                    {state}
                </span>
            </div>
        </div>
    );
}
