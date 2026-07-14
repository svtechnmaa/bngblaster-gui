# Saved Configs — Tags & Owner Filtering

- **Date:** 2026-07-13
- **Status:** Approved (design)
- **Area:** `backend/app/api/v1/bngblaster.py`, `backend/app/models/bngblaster.py`, `backend/app/core/database.py`, `frontend/src/components/BNGBlasterPage.tsx`

## Problem

The Saved Configs panel (Configs tab › JSON Editor) is a flat list. At ~200
configs users scroll a lot to find one. There is no way to categorize configs
or narrow the list by who owns them. We want lightweight organization that
reduces scrolling without adding heavy management overhead.

## Goal

- Attach free-form **tags** to a config for categorization.
- **Filter** the Saved Configs list by tag (and by owner) so the visible set
  shrinks to what the user cares about, combined with the existing search and
  Running/Idle filter.

## Approach (chosen: A)

Add a first-class `tags` column to `bng_configs`, migrated idempotently at
startup using the project's existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
pattern in `init_db()`. Tags are a JSON array of strings on the config.

Rejected alternatives: storing tags inside `config_json` (pollutes the
BNGBlaster config payload); a separate `tags` table with a join (overkill/YAGNI
for free-form string tags).

## Data model

`bng_configs` gains one column:

- `tags` — `JSONB NOT NULL DEFAULT '[]'` — an array of tag strings.

SQLAlchemy model (`models/bngblaster.py`):

```python
tags = Column(JSON, nullable=False, default=list)
```

Migration (`core/database.py`, inside the existing Postgres block in `init_db`):

```python
conn.execute(text(
    "ALTER TABLE bng_configs ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb"
))
```

`create_all` covers fresh SQLite/CI; the ALTER covers existing Postgres DBs.

### Tag normalization (backend, on create/update/clone)

A shared helper sanitizes incoming tags so the stored set is clean:

- Coerce to list of strings; ignore non-strings.
- `trim` each; drop empties.
- De-duplicate case-insensitively, **preserving first-seen original casing**
  (display keeps the user's capitalization; matching is case-insensitive).
- Cap: **max 10 tags per config**, **each tag ≤ 30 chars** (extra dropped).

## Backend changes (`bngblaster.py`)

- `_config_out`: add `"tags": c.tags or []`.
- `create_config`: `tags=_clean_tags(data.get("tags"))`.
- `update_config`: `if "tags" in data: c.tags = _clean_tags(data["tags"])`.
- `clone_config`: copy `tags=list(orig.tags or [])`.
- No new endpoints. The frontend already loads **all** configs via
  `GET /configs`, so the distinct tag set and owner set are derived client-side
  (autocomplete + filter bars) with zero extra API calls.

### RBAC

- Editing tags is part of editing a config: allowed for the **owner**
  (operator+) or an **admin** — identical to editing name/description. Viewers
  cannot edit.
- Filtering by tag/owner is read-only and available to everyone.

## Frontend changes (`BNGBlasterPage.tsx`)

### Types
- `BNGConfig` interface: add `tags?: string[]`.

### Editor form (assign/edit tags)
- Add a **tags input** next to Name/Description in the editor panel: existing
  tags render as removable chips; a text field adds a tag on Enter/comma, with
  **autocomplete suggestions** derived from all configs' existing tags.
- Tags are included in the create (`POST`) and update (`PUT`) request bodies.
- Enforce the same caps client-side (≤10 tags, ≤30 chars) for immediate feedback.

### Saved Configs panel — filtering (reduce scroll)
Two derived filter facets in the panel header, above the list, combined with the
existing **Search** and **Running/Idle** filter:

1. **Owner facet** — a single-select dropdown `Owner: [All ▾]` whose options are
   **All**, **Mine**, then each distinct `owner_username` (sorted). Selecting an
   owner filters the list to that owner; "Mine" uses the `is_owner` flag.
   Derived client-side; no backend change.
2. **Tag chips** — derived distinct tags rendered as toggle chips. Selecting
   chips filters the list. **OR semantics** within tags (a config matches if it
   has *any* selected tag). A "Clear tags" affordance and a match count.

Facets combine with **AND** across dimensions (owner AND tags AND search AND
status); tags are OR **within** the tag dimension.

### Card display
- Each config card shows its tags as small chips.
- Chip color is **auto-derived** from the tag string (deterministic hue via a
  simple hash), theme-aware — no color-management UI.
- Clicking a tag chip on a card toggles that tag in the filter bar.

## Scope / non-goals (YAGNI)

- Free-form tags with autocomplete — **no** admin-curated fixed tag set.
- **No** global tag rename/delete/merge UI in v1 (rename = edit each config).
- Tags are a shared property of the (shared) config — **not** per-user personal
  tags.
- **No** manual tag colors (auto-hued chips only).
- List virtualization is **out of scope**; filtering is expected to keep the
  visible count manageable. Revisit only if DOM size becomes a problem.

## Edge cases

- Legacy rows: `tags` defaults to `[]` (column default + `c.tags or []`).
- Empty/whitespace tags dropped; duplicates collapsed case-insensitively.
- Over-cap tags truncated (drop extras) rather than erroring.
- Clone carries tags over.
- Filtering when no tags exist: the tag chip bar hides itself (nothing to show).

## Verification

- Backend import smoke test (SQLite): `import app.main` succeeds with the new
  column; `_clean_tags` unit-checks (trim/dedupe/cap) via a small script.
- Idempotent migration: running `init_db()` twice does not error
  (`ADD COLUMN IF NOT EXISTS`).
- Frontend: `tsc -b`, `eslint`, `npm run build` green.
- Manual/E2E (optional, needs stack): create a config with tags → appears as
  chips; tag/owner filters narrow the list; clone preserves tags.

## Rollout

Idempotent startup migration — no manual DB step. Deploy = rebuild; existing
configs get `tags = []` automatically.
