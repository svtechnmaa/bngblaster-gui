/** Global in-page confirm modal. Render once (in the app shell). Reads the
 * confirm store and resolves the pending promise on the user's choice.
 * Enter = confirm, Escape / backdrop = cancel. Replaces native window.confirm(). */

import { useEffect } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

import { useConfirmStore } from '../store/useConfirmStore';

export default function ConfirmDialog() {
    const open = useConfirmStore((s) => s.open);
    const options = useConfirmStore((s) => s.options);
    const resolve = useConfirmStore((s) => s.resolve);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') resolve(false);
            else if (e.key === 'Enter') resolve(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, resolve]);

    if (!open || !options) return null;
    const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger } = options;

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50"
            onClick={() => resolve(false)}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title || 'Confirm'}
                className="glass-card w-full max-w-sm p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start gap-3">
                    {danger && (
                        <span className="mt-0.5 shrink-0 w-9 h-9 rounded-full bg-red-500/12 flex items-center justify-center">
                            <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
                        </span>
                    )}
                    <div className="min-w-0">
                        {title && <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">{title}</h3>}
                        <p className="text-sm text-[var(--text-muted)] whitespace-pre-line">{message}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-2 mt-5">
                    <button onClick={() => resolve(false)} className="btn-secondary text-sm">{cancelLabel}</button>
                    <button
                        onClick={() => resolve(true)}
                        autoFocus
                        className={`text-sm inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                            danger ? 'bg-red-500 hover:bg-red-600 focus-visible:ring-red-400' : 'bg-cyan-600 hover:bg-cyan-700 focus-visible:ring-cyan-400'
                        }`}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
