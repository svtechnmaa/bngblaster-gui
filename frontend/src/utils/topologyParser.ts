/**
 * Parse a BNGBlaster config_json into a structured topology object.
 * Only includes sections actually present in the config.
 */

export interface NetworkIface {
    interface?: string;
    address?: string;
    gateway?: string;
    address_ipv6?: string;
    gateway_ipv6?: string;
    mac?: string;
    description?: string;
    'vlan-outer'?: number | string;
}

export interface AccessIface {
    interface?: string;
    address?: string;
    gateway?: string;
    type?: string;
    'vlan-mode'?: string;
    'outer-vlan-min'?: number;
    'outer-vlan-max'?: number;
    'inner-vlan-min'?: number;
    'inner-vlan-max'?: number;
    'stream-group-id'?: number;
    ipv6?: boolean;
    username?: string;
    password?: string;
}

export interface Stream {
    name?: string;
    type?: string;
    direction?: string;
    pps?: number;
    length?: number;
    'network-interface'?: string;
    'stream-group-id'?: number;
}

export interface Topology {
    network: NetworkIface[];
    access: AccessIface[];
    sessions?: Record<string, unknown>;
    protocols: {
        pppoe?: Record<string, unknown>;
        ipoe?: Record<string, unknown>;
        ppp?: Record<string, unknown>;
        dhcp?: Record<string, unknown>;
        dhcpv6?: Record<string, unknown>;
        igmp?: Record<string, unknown>;
        isis?: Record<string, unknown> | Record<string, unknown>[];
        ospf?: Record<string, unknown> | Record<string, unknown>[];
        bgp?: Record<string, unknown> | Record<string, unknown>[];
        ldp?: Record<string, unknown> | Record<string, unknown>[];
        l2tp?: Record<string, unknown>;
        'http-client'?: Record<string, unknown> | Record<string, unknown>[];
        'http-server'?: Record<string, unknown> | Record<string, unknown>[];
        'icmp-client'?: Record<string, unknown> | Record<string, unknown>[];
        'arp-client'?: Record<string, unknown>;
        'access-line'?: Record<string, unknown>;
        'access-line-profiles'?: unknown[];
    };
    streams?: Stream[];
    'session-traffic'?: Record<string, unknown>;
    traffic?: Record<string, unknown>;
}

const PROTOCOL_KEYS = [
    'pppoe', 'ipoe', 'ppp', 'dhcp', 'dhcpv6', 'igmp',
    'isis', 'ospf', 'bgp', 'ldp', 'l2tp',
    'http-client', 'http-server', 'htttp-server', // schema has typo for server
    'icmp-client', 'arp-client',
    'access-line', 'access-line-profiles',
] as const;

export function parseTopology(configJson: unknown): Topology {
    const cfg = (configJson && typeof configJson === 'object') ? (configJson as Record<string, unknown>) : {};
    const interfaces = (cfg.interfaces as Record<string, unknown>) ?? {};

    const topo: Topology = {
        network: Array.isArray(interfaces.network) ? interfaces.network as NetworkIface[] : [],
        access: Array.isArray(interfaces.access) ? interfaces.access as AccessIface[] : [],
        protocols: {},
    };

    if (cfg.sessions && typeof cfg.sessions === 'object') {
        topo.sessions = cfg.sessions as Record<string, unknown>;
    }
    if (Array.isArray(cfg.streams)) {
        topo.streams = cfg.streams as Stream[];
    }
    if (cfg['session-traffic'] && typeof cfg['session-traffic'] === 'object') {
        topo['session-traffic'] = cfg['session-traffic'] as Record<string, unknown>;
    }
    if (cfg.traffic && typeof cfg.traffic === 'object') {
        topo.traffic = cfg.traffic as Record<string, unknown>;
    }

    for (const key of PROTOCOL_KEYS) {
        const v = cfg[key];
        if (v === undefined || v === null) continue;
        // Normalize the 'htttp-server' typo in schema to 'http-server'.
        const normalizedKey = key === 'htttp-server' ? 'http-server' : key;
        (topo.protocols as Record<string, unknown>)[normalizedKey] = v;
    }

    return topo;
}

/**
 * Categorize protocols into network-side (uplink) vs access-side (subscriber).
 * Used to place them on the correct side of the DUT in the topology view.
 */
export const NETWORK_SIDE_PROTOCOLS = ['isis', 'ospf', 'bgp', 'ldp', 'l2tp'] as const;
export const ACCESS_SIDE_PROTOCOLS = ['pppoe', 'ipoe', 'ppp', 'dhcp', 'dhcpv6', 'igmp', 'arp-client', 'access-line'] as const;
export const LINK_PROTOCOLS = ['http-client', 'http-server', 'icmp-client'] as const;

export function protocolSummary(key: string, value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const v = Array.isArray(value) ? value[0] : value;
    const obj = v as Record<string, unknown>;

    switch (key) {
        case 'pppoe':      return obj['service-name'] ? `svc=${obj['service-name']}` : 'enabled';
        case 'ipoe':       return obj['arp-timeout'] ? `arp=${obj['arp-timeout']}s` : 'enabled';
        case 'ppp':        return (obj.authentication as Record<string, unknown>)?.protocol as string ?? 'enabled';
        case 'dhcp':       return obj.enable === false ? 'disabled' : 'enabled';
        case 'dhcpv6':     return obj.enable === false ? 'disabled' : 'v6 enabled';
        case 'igmp':       return `v${obj.version ?? '?'}${obj.group ? ` · ${obj.group}` : ''}`;
        case 'isis':       return `area ${obj.area1 ?? obj.area ?? '?'}`;
        case 'ospf':       return `v${obj.version ?? 2} · area ${obj.area ?? '0'}`;
        case 'bgp':        return `AS${obj['local-as'] ?? '?'} → AS${obj['peer-as'] ?? '?'}`;
        case 'ldp':        return `lsr-id ${obj['lsr-id'] ?? '?'}`;
        case 'l2tp':       return `${(obj.server as unknown[] | undefined)?.length ?? 0} tunnel(s)`;
        case 'http-client':return `url=${obj.url ?? '?'}`;
        case 'http-server':return `:${obj.port ?? '?'}`;
        case 'icmp-client':return `→ ${obj['destination-ipv4-address'] ?? obj.destination ?? '?'}`;
        case 'arp-client': return 'enabled';
        case 'access-line':return 'ANCP';
        default:           return '';
    }
}
