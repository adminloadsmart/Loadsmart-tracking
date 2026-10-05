import jwt, { JwtPayload } from 'jsonwebtoken';

export const PLATFORM_ADMIN_ROLE = 'platform_admin';

/** A signed-in web-portal user (org staff or platform staff) — the main backend's AuthenticatedUser. */
export interface StaffIdentity {
  userId: string;
  tenantId: string | null;
  role: string;
  /** Effective permission keys at token issue (main backend's role ∪ grants). */
  permissions: string[];
  portal: 'organization' | 'platform';
  jti: string | null;
  /** Epoch seconds the token expires. */
  exp: number;
}

/**
 * Which tenant's data the caller may read: their own tenant, every tenant (null) for
 * platform_admin. Other platform-scope roles (sales, KYC desks, …) have no tracking access yet.
 */
export type TenantScope = { tenantId: string } | { allTenants: true };

interface StaffTokenPayload extends JwtPayload {
  id?: string;
  tenantId?: string | null;
  role?: string;
  permissions?: unknown;
  portal?: string;
  purpose?: string;
}

/**
 * Verifies a staff access token issued by the main loadsmart backend (its auth.middleware.ts):
 * HS256 with the shared JWT_SECRET, purpose 'access', portal organization|platform. Returns null
 * on any failure. The main backend's permissionsVersion re-check needs its database, so it isn't
 * repeated here — a role change takes effect when the (15-minute) access token is refreshed.
 */
export function verifyStaffToken(token: string, jwtSecret: string): StaffIdentity | null {
  let decoded: StaffTokenPayload;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as StaffTokenPayload;
  } catch {
    return null;
  }
  if (decoded.purpose !== 'access') return null;
  if (decoded.portal !== 'organization' && decoded.portal !== 'platform') return null;
  if (!decoded.id || !decoded.role || typeof decoded.exp !== 'number') return null;
  return {
    userId: decoded.id,
    tenantId: decoded.tenantId ?? null,
    role: decoded.role,
    permissions: Array.isArray(decoded.permissions)
      ? decoded.permissions.filter((p): p is string => typeof p === 'string')
      : [],
    portal: decoded.portal,
    jti: decoded.jti ?? null,
    exp: decoded.exp,
  };
}

export function tenantScopeFor(identity: StaffIdentity): TenantScope | null {
  if (identity.tenantId) return { tenantId: identity.tenantId };
  if (identity.role === PLATFORM_ADMIN_ROLE) return { allTenants: true };
  return null;
}

/** Permission check mirroring the main backend's requirePermission (platform_admin bypasses). */
export function hasPermission(identity: StaffIdentity, permission: string): boolean {
  return identity.role === PLATFORM_ADMIN_ROLE || identity.permissions.includes(permission);
}

/** True when a row owned by `tenantId` is visible within `scope`. */
export function inScope(scope: TenantScope, tenantId: string): boolean {
  return 'allTenants' in scope || scope.tenantId === tenantId;
}
