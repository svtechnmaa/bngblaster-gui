# Saved Configs Tags & Owner Filtering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free-form tags to BNG configs plus tag/owner filtering in the Saved Configs panel so ~200 configs are manageable without heavy scrolling.

**Architecture:** A new `tags` JSONB column on `bng_configs` (migrated idempotently in `init_db`), threaded through the existing config endpoints. No new API — the frontend already loads all configs, so the tag set and owner set are derived client-side for the editor autocomplete and the filter bars.

**Tech Stack:** FastAPI + SQLAlchemy (Postgres/SQLite), React 19 + Tailwind 4, Zustand. Runtime Python 3.11.

## Global Constraints

- Tag normalization (backend, authoritative): trim; drop empties; de-dupe case-insensitively keeping first-seen casing; **max 10 tags/config**; **each tag ≤ 30 chars** (extras dropped, never error).
- **No new API endpoints.** Tag set + owner set are derived on the frontend from `GET /configs`.
- RBAC: editing tags == editing the config (owner operator+ or admin); filtering is read-only for everyone.
- Filtering combines **AND** across dimensions (owner AND tags AND search AND status); **OR within** the tag dimension.
- Chips are theme-aware with an **auto-derived hue** from the tag string; no manual colors, no global tag-management UI (YAGNI).
- **No test framework is configured** in this repo. Verify backend via the CI import smoke test (SQLite) and a standalone assert script; verify frontend via `tsc -b`, `eslint`, `npm run build`.
- Work on branch `feat/git-restore` (current).

---

### Task 1: Backend — `tags` column + idempotent migration

**Files:**
- Modify: `backend/app/models/bngblaster.py` (BNGConfig, lines 22-31)
- Modify: `backend/app/core/database.py` (`init_db`, Postgres block ~lines 51-58)

**Interfaces:**
- Produces: `BNGConfig.tags` — a `list[str]` column (JSON), default `[]`.

- [ ] **Step 1: Add the column to the model**

In `backend/app/models/bngblaster.py`, inside `class BNGConfig`, add after the `config_json` line:

```python
    config_json = Column(JSON, nullable=False, default=dict)
    tags = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, server_default=func.now())
```

- [ ] **Step 2: Add the idempotent Postgres migration**

In `backend/app/core/database.py`, inside `init_db`'s `with engine.begin() as conn:` block, after the `users` ALTER loop, add:

```python
        conn.execute(text(
            "ALTER TABLE bng_configs ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))
```

- [ ] **Step 3: Verify import + schema (SQLite, no Postgres needed)**

Run from `backend/`:

```bash
SECRET_KEY=dummy DATABASE_URL=sqlite:///./ci-tags.db python3 -c "
import datetime
if not hasattr(datetime,'UTC'): datetime.UTC=datetime.timezone.utc  # py3.10 shim; runtime is 3.11
import app.main
from sqlalchemy import inspect
from app.core.database import engine
cols=[c['name'] for c in inspect(engine).get_columns('bng_configs')]
assert 'tags' in cols, cols
print('ok tags column:', cols)
"; rm -f ci-tags.db
```

Expected: `ok tags column: [... 'tags' ...]`

- [ ] **Step 4: Commit**

```bash
git add backend/app/models/bngblaster.py backend/app/core/database.py
git commit -m "feat(api): add tags column to bng_configs with idempotent migration"
```

---

### Task 2: Backend — `_clean_tags` + thread tags through endpoints

**Files:**
- Modify: `backend/app/api/v1/bngblaster.py` (`_config_out` ~162; `create_config` ~385; `clone_config` ~407; `update_config` ~420-445; add helper near `_name_taken` ~337)
- Test (standalone): `/tmp/claude-0/-opt-bngblaster-gui/.../scratchpad/test_clean_tags.py` (use your session scratchpad dir)

**Interfaces:**
- Consumes: `BNGConfig.tags` (Task 1).
- Produces: `_clean_tags(raw) -> list[str]`; `_config_out(...)` now returns `"tags"`; create/update/clone persist tags.

- [ ] **Step 1: Write the failing standalone test**

Create `test_clean_tags.py` in your scratchpad:

```python
import datetime, os
if not hasattr(datetime, "UTC"): datetime.UTC = datetime.timezone.utc
os.environ.setdefault("SECRET_KEY", "dummy")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
from app.api.v1.bngblaster import _clean_tags

assert _clean_tags(None) == []
assert _clean_tags(["  a ", "b", "a", "A"]) == ["a", "b"], _clean_tags(["  a ", "b", "a", "A"])
assert _clean_tags(["x", 5, "", "  "]) == ["x"]
assert _clean_tags(["y" * 40])[0] == "y" * 30
assert len(_clean_tags([f"t{i}" for i in range(20)])) == 10
assert _clean_tags("not-a-list") == []
print("PASS _clean_tags")
```

- [ ] **Step 2: Run it to verify it fails**

Run from `backend/`:

```bash
PYTHONPATH=$(pwd) python3 /path/to/scratchpad/test_clean_tags.py
```

Expected: `ImportError: cannot import name '_clean_tags'`

- [ ] **Step 3: Implement `_clean_tags`**

In `backend/app/api/v1/bngblaster.py`, add near `_name_taken` (before the config routes):

```python
def _clean_tags(raw: object) -> list[str]:
    """Normalize incoming tags: trim, drop empties, de-dupe case-insensitively
    (keeping first-seen casing), cap at 10 tags of <= 30 chars each."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        t = item.strip()[:30].strip()
        if not t:
            continue
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
        if len(out) >= 10:
            break
    return out
```

- [ ] **Step 4: Thread tags through serialization + endpoints**

`_config_out` — add `tags` to the returned dict:

```python
        "config_json": c.config_json,
        "tags": c.tags or [],
        "user_id": c.user_id,
```

`create_config` — set tags on the new row:

```python
    c = BNGConfig(
        user_id=current_user.id,
        name=name,
        description=data.get("description"),
        config_json=data.get("config_json", {}),
        tags=_clean_tags(data.get("tags")),
    )
```

`clone_config` — carry tags over:

```python
    new_c = BNGConfig(
        user_id=current_user.id,
        name=_unique_name(db, orig.name),
        description=orig.description,
        config_json=orig.config_json,
        tags=list(orig.tags or []),
    )
```

`update_config` — add after the `config_json` block:

```python
    if "config_json" in data:
        c.config_json = data["config_json"]
    if "tags" in data:
        c.tags = _clean_tags(data["tags"])
    db.commit()
```

- [ ] **Step 5: Run the test + import smoke to verify pass**

```bash
cd backend
PYTHONPATH=$(pwd) python3 /path/to/scratchpad/test_clean_tags.py
SECRET_KEY=dummy DATABASE_URL=sqlite:///./ci.db python3 -c "import datetime; hasattr(datetime,'UTC') or setattr(datetime,'UTC',datetime.timezone.utc); import app.main; print('import ok')"; rm -f ci.db
ruff check app/api/v1/bngblaster.py
```

Expected: `PASS _clean_tags`, `import ok`, ruff `All checks passed`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/bngblaster.py
git commit -m "feat(api): persist and serialize config tags (create/update/clone)"
```

---

### Task 3: Frontend — config type + editor tag input

**Files:**
- Modify: `frontend/src/components/BNGBlasterPage.tsx`

**Interfaces:**
- Consumes: backend `tags` field on config responses (Task 2).
- Produces: `cfgTags` editor state included in create/update payloads; `BNGConfig.tags?: string[]`.

- [ ] **Step 1: Add `tags` to the `BNGConfig` interface (line ~34)**

```tsx
interface BNGConfig  {
    id: number; name: string; description?: string; config_json: any; updated_at?: string;
    is_owner?: boolean; owner_username?: string; user_id?: number; tags?: string[];
}
```

- [ ] **Step 2: Add editor tag state (after line ~199 `const [cfgDesc...]`)**

```tsx
    const [cfgTags, setCfgTags] = useState<string[]>([]);
    const [cfgTagInput, setCfgTagInput] = useState('');
```

- [ ] **Step 3: Reset/populate tags in the editor handlers**

In `startNewConfig` add `setCfgTags([]); setCfgTagInput('');`:

```tsx
    const startNewConfig = () => {
        setEditingCfg(null);
        setCfgName(''); setCfgDesc('');
        setCfgTags([]); setCfgTagInput('');
        setCfgJson(JSON.stringify(DEFAULT_CONFIG, null, 2));
        setCfgError('');
    };
```

In `startEditConfig` add `setCfgTags(c.tags ?? []); setCfgTagInput('');`:

```tsx
    const startEditConfig = (c: BNGConfig) => {
        setEditingCfg(c);
        setCfgName(c.name); setCfgDesc(c.description || '');
        setCfgTags(c.tags ?? []); setCfgTagInput('');
        setCfgJson(JSON.stringify(c.config_json, null, 2));
        setCfgError('');
    };
```

- [ ] **Step 4: Send tags in the save payloads (`handleSaveConfig`, lines ~487/490)**

```tsx
                const r = await api.put(`/bngblaster/configs/${editingCfg.id}`, { name: cfgName.trim(), description: cfgDesc, tags: cfgTags, config_json: parsed });
                setConfigs(cs => cs.map(c => c.id === editingCfg.id ? r.data : c));
            } else {
                const r = await api.post('/bngblaster/configs', { name: cfgName.trim(), description: cfgDesc, tags: cfgTags, config_json: parsed });
```

- [ ] **Step 5: Add an `addCfgTag` helper (near `handleSaveConfig`)**

```tsx
    const addCfgTag = (raw: string) => {
        const t = raw.trim().slice(0, 30).trim();
        if (!t) return;
        setCfgTags(prev => prev.some(x => x.toLowerCase() === t.toLowerCase()) || prev.length >= 10 ? prev : [...prev, t]);
        setCfgTagInput('');
    };
```

- [ ] **Step 6: Render the tag editor after the Description input (line ~1649)**

Immediately after the description `<input ... value={cfgDesc} .../>` element, add (uses `allCfgTags` from Task 4; if Task 4 not yet done, temporarily use `[]` and wire the datalist in Task 4):

```tsx
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
```

- [ ] **Step 7: Verify**

Run from `frontend/`:

```bash
npx tsc -b && npx eslint src/components/BNGBlasterPage.tsx && npm run build
```

Expected: tsc "compilation completed", eslint 0 errors, build "✓ built".
(If `allCfgTags` is not yet defined, add it now per Task 4 Step 2 — the two tasks share it.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/BNGBlasterPage.tsx
git commit -m "feat(ui): edit tags on a config in the editor (chips + autocomplete)"
```

---

### Task 4: Frontend — Saved Configs owner + tag filters and card chips

**Files:**
- Modify: `frontend/src/components/BNGBlasterPage.tsx`

**Interfaces:**
- Consumes: `configs` (each with `tags`, `owner_username`, `is_owner`); `savedCfgSearch`, `savedCfgFilter`, `toInstanceName`, `allInstances` (existing).
- Produces: `allCfgTags: string[]`, `selectedTags: string[]`, `ownerFilter: string`, `tagHue(tag)` helper.

- [ ] **Step 1: Add filter state (near line ~194 with the other saved-cfg state)**

```tsx
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [ownerFilter, setOwnerFilter] = useState<string>('all'); // 'all' | 'mine' | <username>
```

- [ ] **Step 2: Derive tag + owner sets and a hue helper (near the other derived values, before the return)**

```tsx
    const allCfgTags = Array.from(new Set(configs.flatMap(c => c.tags ?? []))).sort((a, b) => a.localeCompare(b));
    const allOwners = Array.from(new Set(configs.map(c => c.owner_username).filter(Boolean) as string[])).sort();
    const tagHue = (t: string) => { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
    const toggleTag = (t: string) => setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
```

- [ ] **Step 3: Extend the `visible` filter (inside the IIFE ~line 1467, in the `configs.filter(...)` predicate)**

Add owner + tag conditions to the existing predicate. The predicate currently filters by status + search; add:

```tsx
                                                const visible = configs.filter(c => {
                                                    const instName = toInstanceName(c.name);
                                                    const inst = allInstances.find(i => i.name === instName);
                                                    const isRunning = inst?.status === 'started';
                                                    if (savedCfgFilter === 'running' && !isRunning) return false;
                                                    if (savedCfgFilter === 'idle' && isRunning) return false;
                                                    if (ownerFilter === 'mine' && c.is_owner === false) return false;
                                                    if (ownerFilter !== 'all' && ownerFilter !== 'mine' && c.owner_username !== ownerFilter) return false;
                                                    if (selectedTags.length && !selectedTags.some(t => (c.tags ?? []).includes(t))) return false;
                                                    const q = savedCfgSearch.toLowerCase().trim();
                                                    return !q || c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q);
                                                });
```

- [ ] **Step 4: Render the owner dropdown + tag-chip filter bar**

Just below the existing Search input in the Saved Configs panel header (after the `savedCfgSearch` `<input>`, ~line 1440), add:

```tsx
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={ownerFilter}
                                                    onChange={e => setOwnerFilter(e.target.value)}
                                                    className="input-field text-xs py-1 flex-1"
                                                    aria-label="Filter by owner"
                                                >
                                                    <option value="all">All owners</option>
                                                    <option value="mine">Mine</option>
                                                    {allOwners.map(o => <option key={o} value={o}>@{o}</option>)}
                                                </select>
                                            </div>
                                            {allCfgTags.length > 0 && (
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    {allCfgTags.map(t => {
                                                        const on = selectedTags.includes(t);
                                                        const hue = tagHue(t);
                                                        return (
                                                            <button
                                                                key={t}
                                                                type="button"
                                                                aria-pressed={on}
                                                                onClick={() => toggleTag(t)}
                                                                className="text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors cursor-pointer"
                                                                style={on
                                                                    ? { background: `hsl(${hue} 65% 45%)`, color: '#fff', borderColor: `hsl(${hue} 65% 45%)` }
                                                                    : { background: `hsl(${hue} 60% 50% / 0.12)`, color: `hsl(${hue} 55% 45%)`, borderColor: `hsl(${hue} 60% 50% / 0.30)` }}
                                                            >{t}</button>
                                                        );
                                                    })}
                                                    {selectedTags.length > 0 && (
                                                        <button type="button" onClick={() => setSelectedTags([])} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer">Clear tags</button>
                                                    )}
                                                </div>
                                            )}
```

- [ ] **Step 5: Show tags on each card (in the card body, after the description `<p>`, ~line 1545)**

```tsx
                                                                            {(c.tags ?? []).length > 0 && (
                                                                                <div className="flex flex-wrap gap-1 mt-1">
                                                                                    {(c.tags ?? []).map(t => {
                                                                                        const hue = tagHue(t);
                                                                                        return (
                                                                                            <button
                                                                                                key={t}
                                                                                                type="button"
                                                                                                onClick={e => { e.stopPropagation(); toggleTag(t); }}
                                                                                                className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full border cursor-pointer"
                                                                                                style={{ background: `hsl(${hue} 60% 50% / 0.12)`, color: `hsl(${hue} 55% 45%)`, borderColor: `hsl(${hue} 60% 50% / 0.30)` }}
                                                                                                title={`Filter by tag ${t}`}
                                                                                            >{t}</button>
                                                                                        );
                                                                                    })}
                                                                                </div>
                                                                            )}
```

- [ ] **Step 6: Verify**

Run from `frontend/`:

```bash
npx tsc -b && npx eslint src/components/BNGBlasterPage.tsx && npm run build
```

Expected: tsc "compilation completed", eslint 0 errors (pre-existing `loadInstances` warning only), build "✓ built".

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/BNGBlasterPage.tsx
git commit -m "feat(ui): filter Saved Configs by tag chips + owner; tag chips on cards"
```

---

## Self-Review

- **Spec coverage:** tags column + migration (T1); normalization + serialize + create/update/clone (T2); editor tag input w/ autocomplete (T3); owner dropdown (All/Mine/user), tag-chip OR filter, card chips w/ click-to-filter, auto-hue, combine AND with search/status (T4). No new endpoints ✓. RBAC unchanged (edit path already gates owner/admin) ✓.
- **Type consistency:** `tags: list[str]`/`string[]`; `_clean_tags`, `allCfgTags`, `selectedTags`, `ownerFilter`, `tagHue`, `toggleTag`, `addCfgTag` names consistent across T3/T4. `allCfgTags` defined in T4 Step 2 and consumed by T3 Step 6 — noted in T3 Step 7 that the two share it (implement T4 Step 2 first if executing T3 standalone).
- **Placeholders:** none — all steps carry concrete code/commands.
- **Verification realism:** no pytest in repo → standalone assert script + import smoke + tsc/eslint/build, matching repo conventions.

## Notes for the implementer

- Line numbers are approximate (the file is large and evolving); locate by the quoted anchors (state names, handler names, the `value={cfgDesc}` input, the `configs.filter` predicate).
- `input-field`, `glass-card`, theme tokens (`--text-muted` etc.) already exist.
- Tag chip colors use inline `hsl()` so they work without Tailwind dynamic classes; the low-alpha background reads acceptably in both themes.
