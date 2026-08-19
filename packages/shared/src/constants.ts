// Global vocabularies. Types pick a SUBSET of ITEM_STATUSES.

export const ITEM_STATUSES = [
  'in_stock',
  'open',
  'depleted',
  'expired',
  'discarded',
  'lost',
  'quarantine',
  'in_service',
  'maintenance',
  'out_of_service',
  'retired',
  'installed',
  'used',
  'active',
  'superseded',
  'archived',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const LOCATION_LEVELS = ['site', 'room', 'zone', 'surface'] as const;
export type LocationLevel = (typeof LOCATION_LEVELS)[number];

// Order matters: index = privilege level (see roleAtLeast).
export const USER_ROLES = ['viewer', 'operator', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return USER_ROLES.indexOf(role) >= USER_ROLES.indexOf(minimum);
}

export const FIELD_KINDS = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'status_changed',
  'moved',
  'quantity_adjusted',
  'soft_deleted',
  'restored',
  //
  'ordered',
  'received',
  'reconciled',
  'recounted',
  'recorded',
  'commissioned', // stock → pool
  'retired', // left the pool for good: breakage, not consumption
  'purged', // hard delete from the bin, admin/manager only
  'serviced', // a maintenance plan was carried out
  'linked', // one item attached to another (manual, spare, accessory)
  'unlinked',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITIES = [
  'concept',
  'analogous',
  'variant',
  'item',
  'location',
  'type',
  //
  'request',
  'lot',
  'supplier',
  'action',
  'pool',
  'logEvent',
  'maintenance',
  // Not an inventory row, but "who changed the workshop's logo, and when" belongs in
  // the same append-only feed as everything else.
  'setting',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

// ---------------------------------------------------------------------------
// vocabularies
// ---------------------------------------------------------------------------

/**
 * Tracking depth, a property of each Concept — never a global mode.
 * 1 manual · 2 seeded rate superseded by measurement · 3 actions + maps.
 */
export const TRACKING_LEVELS = [1, 2, 3] as const;
export type TrackingLevel = (typeof TRACKING_LEVELS)[number];

/** Two levels only. With five, everything is urgent within a month. */
export const REQUEST_URGENCIES = ['normal', 'blocking'] as const;
export type RequestUrgency = (typeof REQUEST_URGENCIES)[number];

export const REQUEST_STATUSES = [
  'open',
  'in_lot',
  'ordered',
  'received',
  'cancelled',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const LOT_STATUSES = [
  'draft',
  'ordered',
  'partial',
  'received',
  'cancelled',
] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

/** A line is closed either by full receipt or by giving up on the remainder. */
export const LOT_LINE_STATUSES = ['pending', 'partial', 'received', 'closed'] as const;
export type LotLineStatus = (typeof LOT_LINE_STATUSES)[number];

/** Pooled = counted only (cups). Identified = the individual is known (trays). */
export const POOL_GRANULARITIES = ['pooled', 'identified'] as const;
export type PoolGranularity = (typeof POOL_GRANULARITIES)[number];

export const POOL_STATES = ['available', 'in_use', 'dirty'] as const;
export type PoolState = (typeof POOL_STATES)[number];

export const POOL_UNIT_STATES = [...POOL_STATES, 'retired'] as const;
export type PoolUnitState = (typeof POOL_UNIT_STATES)[number];

export const POOL_EVENT_KINDS = [
  'take', // available → in use
  'return', // in use → dirty
  'wash', // dirty → available
  'retire', // leaves the pool (breakage found by hand)
  'add', // new units bought in
  'recount', // physical count; the correction IS the measured attrition
] as const;
export type PoolEventKind = (typeof POOL_EVENT_KINDS)[number];

/** What a dictionary entry can do when its event appears in the log. */
export const LOG_EFFECT_KINDS = [
  'pool_take',
  'pool_return',
  'pool_wash',
  'consume', // charge a Concept's open item — theoretical only, never stock
  'record_action', // one occurrence of an action, with its whole map
  'occupancy_open',
  'occupancy_close',
  'unit_state', // move an identified reusable (a tray) to a state
] as const;
export type LogEffectKind = (typeof LOG_EFFECT_KINDS)[number];

export const LOG_LINE_STATUSES = [
  'applied',
  'shadow', // matched, but the rule is still in shadow mode
  'unknown_event', // no dictionary entry — this is the configuration screen
  'unknown_object', // an asset the app has never heard of; never auto-created
  'error',
] as const;
export type LogLineStatus = (typeof LOG_LINE_STATUSES)[number];

/** Attribution for anything the log did, so History can separate it from people. */
export const LOG_ACTOR = 'log:automation';

export const LOCALES = ['en', 'de', 'ca'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

/** What one Item is to another. An instrument is the one thing others hang off. */
export const ITEM_RELATIONS = ['document', 'spare', 'accessory', 'consumable'] as const;
export type ItemRelation = (typeof ITEM_RELATIONS)[number];

/**
 * Service and calibration are the same mechanism with different consequences:
 * a machine overdue for service still works, one overdue for calibration
 * produces numbers nobody should sign.
 */
export const MAINTENANCE_KINDS = ['service', 'calibration', 'inspection'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
