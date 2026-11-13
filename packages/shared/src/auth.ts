export const BUSINESS_ROLES = ['owner', 'manager', 'staff'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];
export type Role = BusinessRole | 'platform_admin';

/** Права в админ панела. Кухнята и таблото ползват устройства, не потребители. */
export const PERMISSIONS = [
  'users.manage',      // потребители и роли
  'audit.read',        // журнал на действията
  'settings.manage',   // марка, теми, обекти, начин на поръчка
  'menu.manage',       // меню, филтри, добавки, импорт
  'reports.read',
  'orders.handle',     // приемане и обработка на поръчки
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  platform_admin: PERMISSIONS,
  owner: PERMISSIONS,
  manager: ['settings.manage', 'menu.manage', 'reports.read', 'orders.handle'],
  staff: ['orders.handle'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
