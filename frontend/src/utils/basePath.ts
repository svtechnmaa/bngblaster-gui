/** Shared base-path detection so the router and API client always agree. */

/**
 * The app may be served from `/bngblaster-gui` (reverse-proxy subpath) or root.
 * Returns the detected prefix: `/bngblaster-gui` when under that subpath, else `''`.
 * Use the bare value for URL prefixes (e.g. `${getBasePath()}/api/v1`); for a
 * router basename, fall back to `'/'` (see `getRouterBasename`).
 */
export function getBasePath(): string {
    return window.location.pathname.startsWith('/bngblaster-gui') ? '/bngblaster-gui' : '';
}

/** Router basename variant: same detection, but root resolves to `'/'`. */
export function getRouterBasename(): string {
    return getBasePath() || '/';
}
