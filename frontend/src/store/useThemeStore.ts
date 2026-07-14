/** Light/dark theme (Zustand).
 *
 * Sets `data-theme` on <html>, which drives both the CSS-variable tokens and
 * Tailwind's dark: variant (see the @custom-variant in styles/index.css).
 * Persisted to localStorage('bng-theme'); an inline script in index.html applies
 * it before first paint to avoid a flash, so this store just keeps it in sync.
 */

import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const KEY = 'bng-theme';

function initialTheme(): Theme {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved === 'light' || saved === 'dark') return saved;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

function apply(theme: Theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
        localStorage.setItem(KEY, theme);
    } catch {
        /* ignore */
    }
}

interface ThemeState {
    theme: Theme;
    toggle: () => void;
    setTheme: (t: Theme) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
    theme: initialTheme(),
    toggle: () => set((s) => { const t: Theme = s.theme === 'dark' ? 'light' : 'dark'; apply(t); return { theme: t }; }),
    setTheme: (t) => { apply(t); set({ theme: t }); },
}));

// Reconcile the attribute with the store's resolved value on load.
apply(useThemeStore.getState().theme);
