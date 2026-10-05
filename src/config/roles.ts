// Process roles — one codebase/image, each deployment picks what it runs via ROLE (see
// docs/ROADMAP.md §1). Order matters: roles start in this order and stop in reverse, so the
// HTTP-facing ingress (api, realtime) stops accepting work before the consumers behind it stop.
export const ROLES = ['scheduler', 'processor', 'poller', 'realtime', 'api'] as const;

export type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Parses ROLE: 'all' or a comma-separated list like 'api,processor'. Returns roles in start order. */
export function parseRoles(raw: string): Role[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) throw new Error('ROLE must not be empty');
  if (parts.includes('all')) {
    if (parts.length > 1) throw new Error(`ROLE 'all' cannot be combined with others: "${raw}"`);
    return [...ROLES];
  }

  const unknown = parts.filter((part) => !isRole(part));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ROLE value(s): ${unknown.join(', ')} — expected 'all' or ${ROLES.join('|')}`,
    );
  }

  return ROLES.filter((role) => parts.includes(role));
}
