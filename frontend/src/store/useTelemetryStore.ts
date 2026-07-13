/** Live console telemetry (Zustand).
 *
 * BNGBlasterPage owns the underlying data (selected server, instances, live
 * stats); it publishes a snapshot here so the global TopBar can render the
 * instrument rail on the same row as the brand. Kept tiny and presentational.
 */

import { create } from 'zustand';

export interface Telemetry {
    server: { name: string; host: string; port: number } | null;
    total: number;
    running: number;
    monitoring: boolean;
    txPps: number;
    rxPps: number;
    txBps: number;
    rxBps: number;
    loss: number;
    streams: number;
    hasLive: boolean;
}

const EMPTY: Telemetry = {
    server: null, total: 0, running: 0, monitoring: false,
    txPps: 0, rxPps: 0, txBps: 0, rxBps: 0, loss: 0, streams: 0, hasLive: false,
};

interface TelemetryStore {
    telemetry: Telemetry;
    setTelemetry: (t: Telemetry) => void;
    reset: () => void;
}

export const useTelemetryStore = create<TelemetryStore>((set) => ({
    telemetry: EMPTY,
    setTelemetry: (t) => set({ telemetry: t }),
    reset: () => set({ telemetry: EMPTY }),
}));
