import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type {
  AuditAction,
  AuditEntity,
  FieldDefinition,
  ItemRelation,
  ItemStatus,
  LocationLevel,
  LogEffect,
  LogLineStatus,
  LogParser,
  LotLineStatus,
  LotStatus,
  MaintenanceKind,
  PoolEventKind,
  PoolGranularity,
  PoolUnitState,
  RequestStatus,
  RequestUrgency,
  TrackingLevel,
  TranslatedText,
  UserRole,
} from '@inventory/shared';

// Shared audit columns ( conventions). Timestamps are Unix epoch
// integers in the DB; the API serializes to ISO strings at the boundary.
const auditColumns = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
};

export const types = sqliteTable('types', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  humanIdPrefix: text('human_id_prefix').notNull(),
  validStatuses: text('valid_statuses', { mode: 'json' })
    .$type<ItemStatus[]>()
    .notNull(),
  tracksQuantity: integer('tracks_quantity', { mode: 'boolean' }).notNull(),
  /**
   * Does running out of this matter? An instrument or a calibration document
   * is an Item, and has a Concept underneath so it can still be bought — but
   * "you have 0 pillar drills in stock" is not a warning, it is noise.
   * Home is the stock screen, so it shows only the types that answer yes.
   */
  countsAsStock: integer('counts_as_stock', { mode: 'boolean' }).notNull().default(true),
  fieldDefinitions: text('field_definitions', { mode: 'json' })
    .$type<FieldDefinition[]>()
    .notNull(),
  ...auditColumns,
});

export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(), // L01R02Z03S01
  level: text('level').$type<LocationLevel>().notNull(),
  name: text('name', { mode: 'json' }).$type<TranslatedText>(),
  parentId: text('parent_id').references((): AnySQLiteColumn => locations.id),
  ...auditColumns,
});

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // CON001
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  unit: text('unit').notNull(),
  minStockThreshold: real('min_stock_threshold'),
  notes: text('notes'),
  // Tracking depth is a property of each Concept, never a global mode.
  trackingLevel: integer('tracking_level').$type<TrackingLevel>().notNull().default(1),
  // The level-2 bootstrap: "we use 800 a month", typed before any history
  // exists. NEVER overwritten by measurement — it is shown beside the measured
  // rate so the user can watch their own estimate get corrected.
  seededMonthlyRate: real('seeded_monthly_rate'),
  ...auditColumns,
});

export const analogous = sqliteTable('analogous', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // ANA001
  conceptId: text('concept_id')
    .notNull()
    .references(() => concepts.id),
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  notes: text('notes'),
  ...auditColumns,
});

export const variants = sqliteTable('variants', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // VAR001
  analogousId: text('analogous_id')
    .notNull()
    .references(() => analogous.id),
  // Denormalized on purpose — synced transactionally when analogousId changes.
  conceptId: text('concept_id')
    .notNull()
    .references(() => concepts.id),
  typeId: text('type_id')
    .notNull()
    .references(() => types.id),
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  brand: text('brand'),
  supplier: text('supplier'),
  catalogRef: text('catalog_ref'),
  format: text('format'),
  packSize: real('pack_size'),
  packUnit: text('pack_unit'),
  purity: text('purity'),
  concentration: text('concentration'),
  notes: text('notes'),
  ...auditColumns,
});

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    humanId: text('human_id').notNull().unique(), // supplyAA001
    typeId: text('type_id')
      .notNull()
      .references(() => types.id),
    variantId: text('variant_id').references(() => variants.id),
    // Denormalized on purpose — no JOIN chains for stock queries.
    analogousId: text('analogous_id').references(() => analogous.id),
    conceptId: text('concept_id').references(() => concepts.id),
    locationId: text('location_id').references(() => locations.id),
    status: text('status').$type<ItemStatus>().notNull(),
    quantityInitial: real('quantity_initial'),
    quantityRemaining: real('quantity_remaining'),
    unit: text('unit'),
    priceAmount: integer('price_amount'), // minor units (cents). NEVER float.
    priceCurrency: text('price_currency'),
    priceLocked: integer('price_locked', { mode: 'boolean' })
      .notNull()
      .default(false),
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    customFields: text('custom_fields', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    receivedAt: integer('received_at', { mode: 'timestamp' }),
    openedAt: integer('opened_at', { mode: 'timestamp' }),
    depletedAt: integer('depleted_at', { mode: 'timestamp' }),
    notes: text('notes'),
    createdBy: text('created_by'), // better-auth user id (soft reference)
    // Set by lot reception. Soft references, like createdBy —
    // deleting a lot must never break the items it produced.
    lotId: text('lot_id'),
    lotLineId: text('lot_line_id'),
    // What recorded activities have claimed from this container, UNCAPPED —
    // quantityRemaining is clamped at zero, this is not. The difference from
    // quantityInitial at close is the gap, and it is signed: positive when the
    // workshop used more than any recipe accounted for, negative when the recipes
    // run fat. See services/actions.ts for the whole argument.
    estimatedUsed: real('estimated_used').notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    index('items_concept_status_idx').on(table.conceptId, table.status),
    index('items_location_idx').on(table.locationId),
    index('items_variant_idx').on(table.variantId),
    index('items_status_idx').on(table.status),
  ],
);

// Sequence state for human IDs: supplyAA001…supplyZZ999, CON001…
export const idRegistry = sqliteTable('id_registry', {
  prefix: text('prefix').primaryKey(), // 'supply', 'CON', 'ANA', 'VAR', …
  letterPart: text('letter_part').notNull(), // 'AA' ('' for CON/ANA/VAR style)
  numberPart: integer('number_part').notNull(),
  lastId: text('last_id').notNull(),
});

// Append-only audit trail. Never updated, never deleted.
export const history = sqliteTable(
  'history',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').$type<AuditEntity>().notNull(),
    entityId: text('entity_id').notNull(),
    entityHumanId: text('entity_human_id'),
    action: text('action').$type<AuditAction>().notNull(),
    fieldChanged: text('field_changed'),
    valueBefore: text('value_before', { mode: 'json' }),
    valueAfter: text('value_after', { mode: 'json' }),
    notes: text('notes'),
    userId: text('user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('history_entity_idx').on(table.entityType, table.entityId),
    index('history_created_idx').on(table.createdAt),
  ],
);

// ===========================================================================
// — everything after MVP 1.
//
// The invariant that shapes every table below: forecast and reality are never
// the same record. Lot lines have an ordered side and a received side; a
// Concept has a seeded rate and a measured one; an open Item has an estimate
// and a truth. Nothing here ever writes to items.quantityRemaining.
// ===========================================================================

// ------------------------------------------------------ purchasing

/** A functional demand at Concept level. No purchasing decision in it. */
export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    humanId: text('human_id').notNull().unique(), // REQ001
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id),
    quantity: real('quantity').notNull(),
    unit: text('unit'),
    urgency: text('urgency').$type<RequestUrgency>().notNull().default('normal'),
    // A hint for the buyer ("the Corvid one works better"), never a decision.
    hintVariantId: text('hint_variant_id').references(() => variants.id),
    note: text('note'),
    status: text('status').$type<RequestStatus>().notNull().default('open'),
    lotLineId: text('lot_line_id'), // soft reference — set when triaged
    requestedBy: text('requested_by'),
    ...auditColumns,
  },
  (table) => [
    index('requests_status_idx').on(table.status),
    index('requests_concept_idx').on(table.conceptId),
  ],
);

/** The "+1". A duplicate request is better data than a duplicate row. */
export const requestSupporters = sqliteTable('request_supporters', {
  id: text('id').primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => requests.id),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * A supplier is a row, not a string typed again on every order. Free text
 * splits "Corvid" from "Corvid", and with it the price history that
 * makes the whole purchasing half worth having.
 */
export const suppliers = sqliteTable('suppliers', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // SUP001
  name: text('name').notNull(),
  notes: text('notes'),
  ...auditColumns,
});

/** One order to one supplier, assembled by triaging open requests. */
export const lots = sqliteTable('lots', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // LOT001
  supplierId: text('supplier_id').references(() => suppliers.id),
  // The supplier's PO number. Set at the ORDER step, not at creation: when you
  // open a lot you are still deciding what to buy, so it does not exist yet.
  reference: text('reference'),
  status: text('status').$type<LotStatus>().notNull().default('draft'),
  orderedAt: integer('ordered_at', { mode: 'timestamp' }),
  receivedAt: integer('received_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdBy: text('created_by'),
  ...auditColumns,
});

/**
 * TWO SIDES, NEVER OVERWRITTEN. Ordered 5 × variant A, received
 * 4 × variant B: editing the line to say "4 × B" would destroy exactly the
 * interesting data — short-shipping and substitution are supplier performance.
 */
export const lotLines = sqliteTable(
  'lot_lines',
  {
    id: text('id').primaryKey(),
    lotId: text('lot_id')
      .notNull()
      .references(() => lots.id),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id),
    // — ordered side —
    orderedVariantId: text('ordered_variant_id')
      .notNull()
      .references(() => variants.id),
    orderedQuantity: real('ordered_quantity').notNull(),
    unitPriceAmount: integer('unit_price_amount'), // minor units. NEVER float.
    priceCurrency: text('price_currency'),
    // — received side —
    receivedVariantId: text('received_variant_id').references(() => variants.id),
    receivedQuantity: real('received_quantity').notNull().default(0),
    status: text('status').$type<LotLineStatus>().notNull().default('pending'),
    // Reception detail: one expiry per line, expandable — never 12 date fields.
    expiryDate: integer('expiry_date', { mode: 'timestamp' }),
    locationId: text('location_id').references(() => locations.id),
    notes: text('notes'),
    ...auditColumns,
  },
  (table) => [index('lot_lines_lot_idx').on(table.lotId)],
);

// ------------------------------------------- actions & consumption

/** An activity that consumes: an analysis, a print job, a production batch. */
export const actions = sqliteTable('actions', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // ACT001
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  notes: text('notes'),
  ...auditColumns,
});

/**
 * The consumption map, VERSIONED BY DATE. Editing a quantity closes
 * the current row and opens a new one, so reprocessing history applies the
 * recipe that was in force on the day of each record — otherwise a procedure
 * change in September silently rewrites March and flattens the cost curve.
 */
export const actionLines = sqliteTable(
  'action_lines',
  {
    id: text('id').primaryKey(),
    actionId: text('action_id')
      .notNull()
      .references(() => actions.id),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id),
    quantity: real('quantity').notNull(),
    validFrom: integer('valid_from', { mode: 'timestamp' }).notNull(),
    validTo: integer('valid_to', { mode: 'timestamp' }), // null = in force now
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('action_lines_action_idx').on(table.actionId, table.validTo)],
);

/** "This activity happened N times." Charges theoretical use to open items. */
export const actionRecords = sqliteTable(
  'action_records',
  {
    id: text('id').primaryKey(),
    actionId: text('action_id')
      .notNull()
      .references(() => actions.id),
    count: integer('count').notNull().default(1),
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    userId: text('user_id'),
    source: text('source').notNull().default('manual'), // 'manual' | 'log'
    logLineId: text('log_line_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('action_records_occurred_idx').on(table.occurredAt)],
);

/**
 * Written when a container closes, and only then. One depleted
 * container = one row. `unassigned` is the gap between what the actions
 * claimed and what the container actually held — never called "waste": it
 * does not claim the units were lost, only that no action claimed them.
 */
export const reconciliations = sqliteTable(
  'reconciliations',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    conceptId: text('concept_id').notNull(),
    containerQuantity: real('container_quantity').notNull(),
    theoreticalUsed: real('theoretical_used').notNull(),
    unassigned: real('unassigned').notNull(),
    openedAt: integer('opened_at', { mode: 'timestamp' }),
    closedAt: integer('closed_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('reconciliations_concept_idx').on(table.conceptId)],
);

// ---------------------------------------------- reusable pools

/**
 * A pool with states, NOT individual Items. Modelling each mixing cup as an
 * Item of quantity 1 implies an identity nobody maintains and demands per-jar
 * bookkeeping nobody will ever do.
 */
export const pools = sqliteTable('pools', {
  id: text('id').primaryKey(),
  humanId: text('human_id').notNull().unique(), // POO001
  name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
  granularity: text('granularity').$type<PoolGranularity>().notNull(),
  // Optional link to a Concept so that attrition can reach purchasing.
  conceptId: text('concept_id').references(() => concepts.id),
  // Counters for the pooled granularity. Identified pools derive these from
  // pool_units instead, so they stay 0 there.
  available: integer('available').notNull().default(0),
  inUse: integer('in_use').notNull().default(0),
  dirty: integer('dirty').notNull().default(0),
  /** Does a taken unit sit in an addressable slot? A bench receptacle does not. */
  addressable: integer('addressable', { mode: 'boolean' }).notNull().default(false),
  slotsPerUnit: integer('slots_per_unit'), // e.g. positions in a tray
  notes: text('notes'),
  ...auditColumns,
});

/** Identified members only — a tray, which carries a number. */
export const poolUnits = sqliteTable(
  'pool_units',
  {
    id: text('id').primaryKey(),
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    code: text('code').notNull(), // "3" in Rack_3 — how the log names it
    state: text('state').$type<PoolUnitState>().notNull().default('available'),
    locationId: text('location_id').references(() => locations.id),
    ...auditColumns,
  },
  (table) => [index('pool_units_pool_code_idx').on(table.poolId, table.code)],
);

export const poolEvents = sqliteTable(
  'pool_events',
  {
    id: text('id').primaryKey(),
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    unitId: text('unit_id').references(() => poolUnits.id),
    kind: text('kind').$type<PoolEventKind>().notNull(),
    quantity: integer('quantity').notNull().default(1),
    note: text('note'),
    userId: text('user_id'),
    source: text('source').notNull().default('manual'), // 'manual' | 'log'
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('pool_events_pool_idx').on(table.poolId, table.createdAt)],
);

/**
 * The measuring instrument, not housekeeping. No log and no human
 * will ever record "I dropped a jar", so the pool always drifts upward. The
 * difference between expected and counted IS the attrition, measured.
 */
export const poolRecounts = sqliteTable('pool_recounts', {
  id: text('id').primaryKey(),
  poolId: text('pool_id')
    .notNull()
    .references(() => pools.id),
  expected: integer('expected').notNull(),
  counted: integer('counted').notNull(),
  attrition: integer('attrition').notNull(), // expected - counted
  note: text('note'),
  userId: text('user_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * A sample has NO location of its own. What exists is an occupancy:
 * tray 3, position 1, tagged DMK3-21099-2621703602. Move the tray and forty
 * kits move with it, with zero rows updated.
 */
export const occupancies = sqliteTable(
  'occupancies',
  {
    id: text('id').primaryKey(),
    unitId: text('unit_id')
      .notNull()
      .references(() => poolUnits.id),
    position: text('position'),
    sampleTag: text('sample_tag').notNull(),
    openedAt: integer('opened_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('occupancies_unit_idx').on(table.unitId, table.closedAt),
    index('occupancies_tag_idx').on(table.sampleTag),
  ],
);

// ------------------------------------------------------ log bridge

/** A watched file plus the parser derived from a pasted sample line. */
export const logSources = sqliteTable('log_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  /**
   * Field order + pattern, derived once by highlighting a real line. The
   * pattern is a RegExp source built by the app — never typed by a user.
   */
  parser: text('parser', { mode: 'json' }).$type<LogParser>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Byte offset already ingested. Idempotency: each line takes effect once. */
  cursorOffset: integer('cursor_offset').notNull().default(0),
  lastLineAt: integer('last_line_at', { mode: 'timestamp' }),
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
  /** Silence is the failure mode that does not shout. */
  silenceMinutes: integer('silence_minutes').notNull().default(240),
  ...auditColumns,
});

/** The living configuration: one row per event name the workshop authors. */
export const logEventDefs = sqliteTable('log_event_defs', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // RegistreMostraK
  description: text('description'),
  /** Shadow mode: matched and recorded, but no effect applied. */
  shadow: integer('shadow', { mode: 'boolean' }).notNull().default(true),
  ...auditColumns,
});

/**
 * Dated versions of the effect list. Quantities live HERE, never in a log
 * line — which is exactly what makes the whole history
 * reprocessable when a map turns out to be wrong.
 */
export const logEventVersions = sqliteTable(
  'log_event_versions',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => logEventDefs.id),
    validFrom: integer('valid_from', { mode: 'timestamp' }).notNull(),
    validTo: integer('valid_to', { mode: 'timestamp' }),
    effects: text('effects', { mode: 'json' })
      .$type<LogEffect[]>()
      .notNull(),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('log_event_versions_event_idx').on(table.eventId, table.validTo)],
);

/** Every ingested line, with what it did. `lineHash` is the idempotency key. */
export const logLines = sqliteTable(
  'log_lines',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => logSources.id),
    lineHash: text('line_hash').notNull().unique(),
    raw: text('raw').notNull(),
    /** The log's OWN timestamp. Never the ingestion time. */
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    objectType: text('object_type'),
    objectId: text('object_id'),
    eventName: text('event_name'),
    status: text('status').$type<LogLineStatus>().notNull(),
    detail: text('detail'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('log_lines_status_idx').on(table.status),
    index('log_lines_event_idx').on(table.eventName),
    index('log_lines_occurred_idx').on(table.occurredAt),
  ],
);

// ------------------------------------------------------- equipment
//
// An instrument is an Item, but it is the one kind that other Items hang off:
// its manual, its calibration certificate, the spare torch in the drawer. A
// generic link table rather than columns on `items`, because the list of
// relations a workshop invents is not knowable in advance — the same argument that
// made Types user-defined in the first place.

export const itemLinks = sqliteTable(
  'item_links',
  {
    id: text('id').primaryKey(),
    /** The instrument. */
    parentItemId: text('parent_item_id')
      .notNull()
      .references(() => items.id),
    /** The manual, the spare, the accessory. */
    childItemId: text('child_item_id')
      .notNull()
      .references(() => items.id),
    relation: text('relation').$type<ItemRelation>().notNull(),
    notes: text('notes'),
    ...auditColumns,
  },
  (table) => [
    index('item_links_parent_idx').on(table.parentItemId),
    index('item_links_child_idx').on(table.childItemId),
  ],
);

/**
 * "Service this every 6 months" or "every 500 holes", whichever comes
 * first. Both, because a caliper ages by the calendar and a pillar drill
 * ages by use — and the use counter can come from the machine controller log, which already
 * knows how many runs the machine did.
 */
export const maintenancePlans = sqliteTable(
  'maintenance_plans',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    name: text('name', { mode: 'json' }).$type<TranslatedText>().notNull(),
    kind: text('kind').$type<MaintenanceKind>().notNull().default('service'),
    everyDays: integer('every_days'),
    everyUses: integer('every_uses'),
    /** Runs counted since the last service; the log or a person bumps it. */
    usesSinceLast: integer('uses_since_last').notNull().default(0),
    lastDoneAt: integer('last_done_at', { mode: 'timestamp' }),
    /** Computed on every change so "what is due" is one indexed query. */
    nextDueAt: integer('next_due_at', { mode: 'timestamp' }),
    notes: text('notes'),
    ...auditColumns,
  },
  (table) => [
    index('maintenance_item_idx').on(table.itemId),
    index('maintenance_due_idx').on(table.nextDueAt),
  ],
);

/** Append-only: what was done, when, by whom. A service history, not a status. */
export const maintenanceRecords = sqliteTable(
  'maintenance_records',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => maintenancePlans.id),
    doneAt: integer('done_at', { mode: 'timestamp' }).notNull(),
    userId: text('user_id'),
    /** The use counter at the moment of service, so the next window is real. */
    usesAtService: integer('uses_at_service'),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('maintenance_records_plan_idx').on(table.planId)],
);

// ---------------------------------------------------------------------------
// Fast login
// ---------------------------------------------------------------------------

/**
 * One chord per person, and no two people may share one — which is exactly why
 * the machine generates them and nobody types their own.
 *
 * The chord is stored **as written, not hashed**, and that is a decision rather
 * than an oversight. Signing in with it means finding the owner *from* the
 * chord, which a salted hash cannot do; and its owner must be able to look it
 * up again after a fortnight's holiday, which a one-way hash also cannot do.
 * So it is what it was always meant to be: an identification, not a password
 * — a code on the workshop door. Passwords stay hashed and still work; a chord is
 * the shortcut, and any admin can revoke one.
 */
export const fastKeys = sqliteTable('fast_keys', {
  id: text('id').primaryKey(),
  /** Soft reference to the better-auth user id, like items.createdBy. */
  userId: text('user_id').notNull().unique(),
  /** Normalized form, e.g. `d+e+w x+c+v`. Unique across every account. */
  chord: text('chord').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Whatever the workshop has configured about itself — today that is the logo, the
 * workshop's name and the three theme colours.
 *
 * A key/value table rather than a one-row `settings` table with a column per
 * setting: every new setting would otherwise be a migration, and settings are
 * exactly the thing that gets added on a Tuesday afternoon. The value is JSON,
 * validated by a Zod schema at the route (see schemas/branding.ts) — the shape
 * lives in the type system, not in the DDL.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  /** Soft reference to the better-auth user id, like items.createdBy. */
  updatedBy: text('updated_by'),
});

export type UserRoleColumn = UserRole; // re-export for auth schema (Phase 0.5)
