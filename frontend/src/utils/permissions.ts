/**
 * Permission helper — single source of truth for RBAC.
 * Role hierarchy: admin > operator > viewer
 */

export type Role = 'admin' | 'operator' | 'viewer';

export function hasRole(userRole: string | undefined, required: Role): boolean {
    if (!userRole) return false;
    if (required === 'viewer') return true;
    if (required === 'operator') return userRole === 'operator' || userRole === 'admin';
    if (required === 'admin') return userRole === 'admin';
    return false;
}

export const can = {
    // BNG server CRUD (admin only)
    manageBNGServers: (role: Role) => role === 'admin',

    // BNG config CRUD with ownership
    createBNGConfig: (role: Role) => role !== 'viewer',
    editBNGConfig:   (role: Role, isOwner: boolean) => (isOwner && role !== 'viewer') || role === 'admin',
    deleteBNGConfig: (role: Role, isOwner: boolean) => (isOwner && role !== 'viewer') || role === 'admin',
    cloneBNGConfig:  (_role: Role) => true,

    // Instance lifecycle
    runBNGInstance:  (role: Role, isOwner: boolean) => isOwner || role === 'admin',
    stopBNGInstance: (role: Role) => role !== 'viewer',

    // User management
    manageUsers: (role: Role) => role === 'admin',
};
