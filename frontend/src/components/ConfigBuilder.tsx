/**
 * ConfigBuilder — Visual BNGBlaster config builder driven by all_conf.yml schema.
 *
 * UX:
 *  • Section selector — pick which top-level sections to include (default: none)
 *  • Per-field checkbox — only checked fields appear in the output JSON
 *  • Live JSON preview (Monaco read-only)
 *  • "Use this Config" → sends generated JSON to parent editor
 */

import { useState, useEffect, useCallback, useContext, createContext } from 'react';
import Editor from '@monaco-editor/react';
import {
    PlusIcon, TrashIcon,
    ChevronDownIcon, ChevronRightIcon,
    ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import api from '../services/api';

// ── Schema types ──────────────────────────────────────────────────────────────

interface SchemaLeaf {
    __widget: 'text_input' | 'number_input' | 'selectbox' | 'slider' | 'customize';
    __value: any;
    __datatype: 'str' | 'int' | 'float' | 'bool' | 'interface_auto';
    __options: any;
    __label?: string;
}

function isLeaf(node: any): node is SchemaLeaf {
    return node !== null && typeof node === 'object' && !Array.isArray(node) && '__widget' in node;
}
function isList(node: any): boolean { return Array.isArray(node); }

// ── Value helpers ─────────────────────────────────────────────────────────────

function coerce(val: any, dtype: string): any {
    if (dtype === 'bool')  return val === true || val === 'true';
    if (dtype === 'int')   return typeof val === 'number' ? Math.round(val) : (parseInt(String(val)) || 0);
    if (dtype === 'float') return typeof val === 'number' ? val : (parseFloat(String(val)) || 0);
    return String(val ?? '');
}

function initValue(schema: any): any {
    if (isLeaf(schema)) return coerce(schema.__value, schema.__datatype);
    if (isList(schema)) return [initValue(schema[0])];
    if (schema && typeof schema === 'object') {
        const obj: Record<string, any> = {};
        for (const [k, v] of Object.entries(schema))
            if (!k.startsWith('__')) obj[k] = initValue(v);
        return obj;
    }
    return schema;
}

// Build output JSON — only include leaves where enabledFields[path] === true
function buildFiltered(schema: any, value: any, basePath: string, ef: Record<string, boolean>): any {
    if (isLeaf(schema)) {
        return ef[basePath] ? value : undefined;
    }
    if (isList(schema)) {
        if (!Array.isArray(value)) return undefined;
        const items = value
            .map((item, idx) => buildFiltered(schema[0], item, `${basePath}[${idx}]`, ef))
            .filter(item => item !== undefined && typeof item === 'object' && Object.keys(item).length > 0);
        return items.length > 0 ? items : undefined;
    }
    if (schema && typeof schema === 'object') {
        const result: Record<string, any> = {};
        for (const [k, v] of Object.entries(schema)) {
            if (k.startsWith('__') || k.startsWith('_comment')) continue;
            const childPath = `${basePath}.${k}`;
            const childVal = buildFiltered(v, value?.[k], childPath, ef);
            if (childVal !== undefined) result[k] = childVal;
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }
    return value;
}

// Count enabled leaf paths under a prefix
function countEnabled(prefix: string, ef: Record<string, boolean>): number {
    return Object.entries(ef).filter(([k, v]) => v && k.startsWith(prefix)).length;
}

// ── Field context (avoids deep prop-drilling for checkbox state) ──────────────

interface FieldCtx {
    enabledFields: Record<string, boolean>;
    toggleField:   (path: string) => void;
}
const FieldContext = createContext<FieldCtx>({ enabledFields: {}, toggleField: () => {} });

// ── Section categories ────────────────────────────────────────────────────────

const CATEGORIES: { label: string; sections: string[] }[] = [
    { label: 'Essential',   sections: ['interfaces', 'sessions'] },
    { label: 'Protocol',    sections: ['ipoe', 'pppoe', 'ppp', 'dhcp', 'dhcpv6', 'igmp'] },
    { label: 'Traffic',     sections: ['traffic', 'streams', 'session-traffic'] },
    { label: 'Routing',     sections: ['l2tp-server', 'isis', 'ospf', 'ldp', 'bgp'] },
    { label: 'Access',      sections: ['access-line', 'access-line-profiles'] },
    { label: 'Application', sections: ['http-client', 'http-server', 'icmp-client', 'arp-client'] },
];

// ── Leaf field (checkbox + widget) ────────────────────────────────────────────

function LeafField({ fieldKey, schema, value, onChange, path }: {
    fieldKey: string;
    schema:   SchemaLeaf;
    value:    any;
    onChange: (v: any) => void;
    path:     string;
}) {
    const { enabledFields, toggleField } = useContext(FieldContext);
    const checked = !!enabledFields[path];
    const { __widget: widget, __options: opts, __datatype: dtype } = schema;
    const label = fieldKey.replace(/-/g, ' ').replace(/_/g, ' ');

    return (
        <div className={`rounded-lg border transition-all ${
            checked ? 'border-orange-300 bg-orange-50 dark:bg-orange-500/10' : 'border-[var(--border-color)] bg-[var(--bg-card)] hover:border-[var(--border-color)]'
        }`}>
            {/* Checkbox row */}
            <label className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleField(path)}
                    className="accent-orange-500 w-3.5 h-3.5 shrink-0 cursor-pointer"
                />
                <span
                    className={`text-xs font-semibold uppercase tracking-wide truncate ${
                        checked ? 'text-orange-700 dark:text-orange-400' : 'text-[var(--text-muted)]'
                    }`}
                    title={fieldKey}
                >
                    {label}
                </span>
            </label>

            {/* Widget — shown only when checked */}
            {checked && (
                <div className="px-3 pb-3">
                    {widget === 'selectbox' && Array.isArray(opts) && (
                        <select
                            className="input-field text-xs py-1 w-full"
                            value={String(value)}
                            onChange={e => onChange(coerce(e.target.value, dtype))}
                        >
                            {opts.map((o: any) => (
                                <option key={String(o)} value={String(o)}>{String(o)}</option>
                            ))}
                        </select>
                    )}

                    {widget === 'number_input' && (
                        <input
                            type="number"
                            className="input-field text-xs py-1 w-full"
                            value={value}
                            min={opts?.__min}
                            max={opts?.__max}
                            step={opts?.__step ?? (dtype === 'float' ? 0.01 : 1)}
                            onChange={e => {
                                const v = dtype === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value);
                                onChange(isNaN(v) ? 0 : v);
                            }}
                        />
                    )}

                    {widget === 'slider' && (
                        <div className="flex items-center gap-2 mt-1">
                            <input
                                type="range"
                                className="flex-1 accent-orange-500"
                                value={value}
                                min={opts?.__min ?? 0}
                                max={opts?.__max ?? 100}
                                step={1}
                                onChange={e => onChange(parseInt(e.target.value))}
                            />
                            <span className="text-xs text-[var(--text-muted)] w-8 text-right shrink-0 font-mono">{value}</span>
                        </div>
                    )}

                    {(widget === 'text_input' || widget === 'customize') && (
                        <input
                            type="text"
                            className="input-field text-xs py-1 w-full"
                            value={String(value ?? '')}
                            placeholder={dtype === 'interface_auto' ? 'e.g. eth0' : ''}
                            onChange={e => onChange(e.target.value)}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

// ── Object fields renderer ────────────────────────────────────────────────────

function ObjectFields({ schema, value, onChange, basePath, depth = 0 }: {
    schema:   Record<string, any>;
    value:    Record<string, any>;
    onChange: (v: Record<string, any>) => void;
    basePath: string;
    depth?:   number;
}) {
    const leaves:  [string, SchemaLeaf][]          = [];
    const lists:   [string, any[]][]               = [];
    const objects: [string, Record<string, any>][] = [];

    for (const [k, v] of Object.entries(schema)) {
        if (k.startsWith('__') || k.startsWith('_comment')) continue;
        if (isLeaf(v))                       leaves.push([k, v]);
        else if (isList(v))                  lists.push([k, v]);
        else if (v && typeof v === 'object') objects.push([k, v]);
    }

    const upd = (key: string, newVal: any) => onChange({ ...(value ?? {}), [key]: newVal });

    return (
        <div className="space-y-3">
            {/* Leaf fields grid */}
            {leaves.length > 0 && (
                <div className={`grid gap-3 ${
                    depth === 0
                        ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-3'
                        : 'grid-cols-2 md:grid-cols-3'
                }`}>
                    {leaves.map(([k, s]) => (
                        <LeafField
                            key={k}
                            fieldKey={k}
                            schema={s}
                            path={`${basePath}.${k}`}
                            value={value?.[k] ?? coerce(s.__value, s.__datatype)}
                            onChange={v => upd(k, v)}
                        />
                    ))}
                </div>
            )}

            {/* List sub-sections */}
            {lists.map(([k, listSchema]) => (
                <ListSection
                    key={k}
                    label={k}
                    itemSchema={listSchema[0]}
                    basePath={`${basePath}.${k}`}
                    items={value?.[k] ?? []}
                    onChange={items => upd(k, items)}
                    depth={depth + 1}
                />
            ))}

            {/* Object sub-sections */}
            {objects.map(([k, objSchema]) => (
                <CollapsibleSection key={k} label={k} defaultOpen={depth < 1}>
                    <ObjectFields
                        schema={objSchema}
                        value={value?.[k] ?? {}}
                        basePath={`${basePath}.${k}`}
                        onChange={v => upd(k, v)}
                        depth={depth + 1}
                    />
                </CollapsibleSection>
            ))}
        </div>
    );
}

// ── Collapsible section wrapper ───────────────────────────────────────────────

function CollapsibleSection({ label, children, defaultOpen = true }: {
    label: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-hover)] hover:bg-[var(--bg-hover)] transition-colors text-left"
            >
                {open
                    ? <ChevronDownIcon  className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                    : <ChevronRightIcon className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                }
                <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wide">{label}</span>
            </button>
            {open && <div className="p-3">{children}</div>}
        </div>
    );
}

// ── List section ──────────────────────────────────────────────────────────────

function ListSection({ label, itemSchema, basePath, items, onChange, depth }: {
    label:      string;
    itemSchema: Record<string, any>;
    basePath:   string;
    items:      any[];
    onChange:   (items: any[]) => void;
    depth:      number;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const { enabledFields } = useContext(FieldContext);

    const addItem    = () => onChange([...items, initValue(itemSchema)]);
    const removeItem = (i: number) => onChange(items.filter((_, idx) => idx !== i));
    const updateItem = (i: number, val: any) => onChange(items.map((item, idx) => idx === i ? val : item));

    const checkedCount = countEnabled(basePath, enabledFields);

    return (
        <div className="border border-cyan-500/25 rounded-lg overflow-hidden">
            <div
                className="flex items-center justify-between bg-cyan-500/10 px-4 py-2.5 cursor-pointer select-none"
                onClick={() => setCollapsed(c => !c)}
            >
                <div className="flex items-center gap-2">
                    {collapsed
                        ? <ChevronRightIcon className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                        : <ChevronDownIcon  className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                    }
                    <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 uppercase tracking-wide">{label}</span>
                    <span className="text-xs bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 px-1.5 py-0.5 rounded-full font-bold">
                        {items.length}
                    </span>
                    {checkedCount > 0 && (
                        <span className="text-xs bg-orange-200 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 px-1.5 py-0.5 rounded-full font-bold">
                            {checkedCount} fields on
                        </span>
                    )}
                </div>
                <button
                    onClick={e => { e.stopPropagation(); addItem(); }}
                    className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700 font-medium"
                >
                    <PlusIcon className="w-3.5 h-3.5" /> Add
                </button>
            </div>

            {!collapsed && items.map((item, idx) => (
                <div key={idx} className="border-t border-[var(--border-color)] p-4">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                            {label} #{idx + 1}
                        </span>
                        <button
                            onClick={() => removeItem(idx)}
                            className="text-red-400 hover:text-red-600 transition-colors"
                            aria-label="Remove item"
                            title="Remove item"
                        >
                            <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <ObjectFields
                        schema={itemSchema}
                        value={item ?? {}}
                        basePath={`${basePath}[${idx}]`}
                        onChange={v => updateItem(idx, v)}
                        depth={depth}
                    />
                </div>
            ))}

            {!collapsed && items.length === 0 && (
                <div className="border-t border-[var(--border-color)] p-4 text-center">
                    <button
                        onClick={addItem}
                        className="text-xs text-cyan-600 hover:text-cyan-700 flex items-center gap-1 mx-auto"
                    >
                        <PlusIcon className="w-3.5 h-3.5" /> Add first item
                    </button>
                </div>
            )}
        </div>
    );
}

// ── Section panel dispatcher ──────────────────────────────────────────────────

function SectionPanel({ sectionKey, schema, value, onChange }: {
    sectionKey: string;
    schema:     any;
    value:      any;
    onChange:   (v: any) => void;
}) {
    if (isList(schema)) {
        return (
            <ListSection
                label={sectionKey}
                itemSchema={schema[0]}
                basePath={sectionKey}
                items={value ?? []}
                onChange={onChange}
                depth={0}
            />
        );
    }
    if (isLeaf(schema)) {
        return (
            <LeafField
                fieldKey={sectionKey}
                schema={schema}
                path={sectionKey}
                value={value}
                onChange={onChange}
            />
        );
    }
    return (
        <ObjectFields
            schema={schema}
            value={value ?? {}}
            basePath={sectionKey}
            onChange={onChange}
        />
    );
}

// ── Main ConfigBuilder ────────────────────────────────────────────────────────

export default function ConfigBuilder({ onUseConfig }: { onUseConfig: (json: any) => void }) {
    const [schema, setSchema]               = useState<Record<string, any> | null>(null);
    const [loading, setLoading]             = useState(true);
    const [error, setError]                 = useState('');
    const [enabled, setEnabled]             = useState<Set<string>>(new Set());   // no sections by default
    const [values, setValues]               = useState<Record<string, any>>({});
    const [enabledFields, setEnabledFields] = useState<Record<string, boolean>>({}); // field checkboxes
    const [activeSection, setActiveSection] = useState<string>('');
    const [showPreview, setShowPreview]     = useState(true);

    useEffect(() => {
        api.get('/bngblaster/schema')
            .then(r => {
                setSchema(r.data);
                const init: Record<string, any> = {};
                for (const [k, v] of Object.entries(r.data as Record<string, any>))
                    init[k] = initValue(v);
                setValues(init);
            })
            .catch(e => setError(e.response?.data?.detail || 'Failed to load schema'))
            .finally(() => setLoading(false));
    }, []);

    const toggleSection = (name: string) => {
        setEnabled(prev => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
                if (activeSection === name)
                    setActiveSection([...next][0] ?? '');
            } else {
                next.add(name);
                setActiveSection(name);
            }
            return next;
        });
    };

    const toggleField = useCallback((path: string) => {
        setEnabledFields(prev => ({ ...prev, [path]: !prev[path] }));
    }, []);

    const updateSection = useCallback((name: string, val: any) => {
        setValues(prev => ({ ...prev, [name]: val }));
    }, []);

    const buildJson = useCallback((): Record<string, any> => {
        if (!schema) return {};
        const result: Record<string, any> = {};
        for (const name of enabled) {
            if (!values[name]) continue;
            const filtered = buildFiltered(schema[name], values[name], name, enabledFields);
            if (filtered !== undefined && typeof filtered === 'object' && Object.keys(filtered).length > 0)
                result[name] = filtered;
            else if (filtered !== undefined && typeof filtered !== 'object')
                result[name] = filtered;
        }
        return result;
    }, [schema, enabled, values, enabledFields]);

    const previewStr = JSON.stringify(buildJson(), null, 2);

    if (loading) return (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] p-6 justify-center">
            <svg className="animate-spin w-4 h-4 text-cyan-600" fill="none" viewBox="0 0 24 24" role="status" aria-label="Loading">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Loading config schema…
        </div>
    );

    if (error) return (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-600 dark:text-red-400">{error}</div>
    );

    if (!schema) return null;

    const allSections = Object.keys(schema);
    const ctxValue = { enabledFields, toggleField };

    return (
        <FieldContext.Provider value={ctxValue}>
        <div className="space-y-6">

            {/* ── Section selector ── */}
            <div className="border border-[var(--border-color)] rounded-lg p-4 bg-[var(--bg-hover)]">
                <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
                    1. Choose sections to include
                </p>
                <div className="space-y-4">
                    {CATEGORIES.map(cat => {
                        const available = cat.sections.filter(s => allSections.includes(s));
                        if (available.length === 0) return null;
                        return (
                            <div key={cat.label}>
                                <p className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-widest mb-2">
                                    {cat.label}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {available.map(sec => {
                                        const cnt = countEnabled(sec, enabledFields);
                                        return (
                                            <button
                                                key={sec}
                                                onClick={() => toggleSection(sec)}
                                                className={`text-xs px-3 py-1 rounded-full border font-medium transition-all flex items-center gap-1.5 ${
                                                    enabled.has(sec)
                                                        ? 'bg-cyan-500 text-white border-cyan-500 shadow-sm'
                                                        : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-color)] hover:border-cyan-400 hover:text-cyan-600'
                                                }`}
                                            >
                                                {sec}
                                                {cnt > 0 && (
                                                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${enabled.has(sec) ? 'bg-cyan-400 text-white' : 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300'}`}>
                                                        {cnt}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── Field form ── */}
            {enabled.size > 0 && (
                <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
                    <div className="px-4 py-2 bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                            2. Check fields to configure
                        </p>
                    </div>

                    {/* Sub-tabs */}
                    <div className="flex overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-card)]">
                        {[...enabled].map(sec => {
                            const cnt = countEnabled(sec, enabledFields);
                            return (
                                <button
                                    key={sec}
                                    onClick={() => setActiveSection(sec)}
                                    className={`px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 flex items-center gap-1.5 ${
                                        activeSection === sec
                                            ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/10'
                                            : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                                    }`}
                                >
                                    {sec}
                                    {cnt > 0 && (
                                        <span className="text-xs bg-cyan-500 text-white px-1.5 py-0.5 rounded-full font-bold">
                                            {cnt}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Section fields */}
                    <div className="p-4">
                        {activeSection && enabled.has(activeSection) && schema[activeSection]
                            ? (
                                <SectionPanel
                                    key={activeSection}
                                    sectionKey={activeSection}
                                    schema={schema[activeSection]}
                                    value={values[activeSection]}
                                    onChange={v => updateSection(activeSection, v)}
                                />
                            ) : (
                                <p className="text-sm text-[var(--text-muted)] text-center py-6">
                                    Select a section tab above.
                                </p>
                            )
                        }
                    </div>
                </div>
            )}

            {enabled.size === 0 && (
                <div className="text-sm text-[var(--text-muted)] text-center py-8 border border-dashed border-[var(--border-color)] rounded-lg">
                    Select sections above to begin.
                </div>
            )}

            {/* ── JSON Preview ── */}
            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
                <div
                    className="flex items-center justify-between bg-[var(--bg-hover)] px-4 py-2.5 cursor-pointer"
                    onClick={() => setShowPreview(p => !p)}
                >
                    <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-2">
                        {showPreview
                            ? <ChevronDownIcon  className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            : <ChevronRightIcon className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        }
                        3. Generated JSON Preview
                        <span className="text-xs bg-[var(--bg-card)] text-[var(--text-muted)] px-1.5 py-0.5 rounded font-mono border border-[var(--border-color)]">
                            {previewStr.split('\n').length} lines
                        </span>
                    </span>
                    <button
                        onClick={e => { e.stopPropagation(); onUseConfig(buildJson()); }}
                        className="btn-primary text-xs py-1 px-3 flex items-center gap-1.5"
                    >
                        <ArrowUpTrayIcon className="w-3.5 h-3.5" />
                        Use this Config
                    </button>
                </div>

                {showPreview && (
                    <Editor
                        height="300px"
                        language="json"
                        value={previewStr}
                        theme={document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs'}
                        options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            fontSize: 11,
                            lineNumbers: 'off',
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                        }}
                    />
                )}
            </div>

        </div>
        </FieldContext.Provider>
    );
}
