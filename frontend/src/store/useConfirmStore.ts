/** In-page confirm dialog (Zustand) — replaces native window.confirm().
 *
 * Usage (anywhere, incl. non-component code):
 *   import { confirmDialog } from '../store/useConfirmStore';
 *   if (!(await confirmDialog({ message: 'Delete this?', danger: true }))) return;
 *
 * A single <ConfirmDialog /> (rendered once in the app shell) reads this store
 * and resolves the pending promise when the user chooses.
 */

import { create } from 'zustand';

export interface ConfirmOptions {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
}

interface ConfirmState {
    open: boolean;
    options: ConfirmOptions | null;
    _resolve: ((v: boolean) => void) | null;
    request: (opts: ConfirmOptions) => Promise<boolean>;
    resolve: (v: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
    open: false,
    options: null,
    _resolve: null,
    request: (opts) =>
        new Promise<boolean>((resolve) => {
            // If a dialog is already open, cancel it before showing the new one.
            get()._resolve?.(false);
            set({ open: true, options: opts, _resolve: resolve });
        }),
    resolve: (v) => {
        const r = get()._resolve;
        set({ open: false, options: null, _resolve: null });
        r?.(v);
    },
}));

/** Imperative helper — returns a promise that resolves true (confirm) / false (cancel). */
export const confirmDialog = (opts: ConfirmOptions) => useConfirmStore.getState().request(opts);
