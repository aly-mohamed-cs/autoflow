export const ROLES = ['viewer', 'operator', 'builder', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * viewer:   see automations, runs and robots
 * operator: + run automations, manage schedules, webhooks and queue items
 * builder:  + publish automations from Studio, manage credentials
 * admin:    + users, robots, settings, audit log
 */
export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  builder: 'Builder',
  admin: 'Administrator',
};

export const atLeast = (role: Role, required: Role): boolean => ROLES.indexOf(role) >= ROLES.indexOf(required);

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value);
