import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { LOG_ACTOR } from '@inventory/shared';
import type { IngestResult, LogEffect, LogField, LogParser } from '@inventory/shared';
import { db } from '../db/client';
import {
  actionRecords,
  concepts,
  items,
  logEventDefs,
  logEventVersions,
  logLines,
  logSources,
  occupancies,
  poolUnits,
  pools,
} from '../db/schema';
import { chargeAction, openContainerFor } from './actions';
import { logEvent } from './history';
import { applyPoolEvent } from '../routes/pools';

// The log bridge. The machine controller reports facts; the inventory
// interprets them. Two invariants hold this file together:
//
//   RULE — the log may report measurements, never consumption.
//                 Quantities live in the dated dictionary, never in a line.
//   RULE — the log can do nothing the UI cannot. Everything below
//                 routes through the same service functions the screens use.

// ---------------------------------------------------------------------------
// Parsing. No user ever writes a regular expression: they paste a real line
// and highlight which token is which, and the pattern is derived from that.
// ---------------------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `Mostra_DMK3-21099-2621703602` → type `Mostra`, id `DMK3-…`. */
const TYPE_ID_RE = /^([A-Za-z][A-Za-z0-9]*)_(.+)$/;

export function deriveParser(sample: string, assignments: LogField[]): LogParser {
  const tokens = sample.trim().split(/\s+/);
  if (tokens.length !== assignments.length) {
    throw new Error(
      `The sample line has ${tokens.length} parts but ${assignments.length} were labelled`,
    );
  }

  const hasSeparateType = assignments.includes('type');
  const parts: string[] = [];
  const groups: LogField[] = [];

  tokens.forEach((token, index) => {
    const field = assignments[index]!;
    if (field === 'skip') {
      parts.push('\\S+');
      return;
    }
    // One token can hold both the object type and its identifier. Splitting is
    // decided here, once, from the sample — and it shows up in the preview, so
    // it is never invisible magic.
    if (field === 'id' && !hasSeparateType && TYPE_ID_RE.test(token)) {
      parts.push('([A-Za-z][A-Za-z0-9]*)_(\\S+)');
      groups.push('type', 'id');
      return;
    }
    parts.push('(\\S+)');
    groups.push(field);
  });

  return { pattern: `^\\s*${parts.join('\\s+')}\\s*$`, groups };
}

export interface ParsedLine {
  raw: string;
  time: string | null;
  type: string | null;
  id: string | null;
  event: string | null;
  matched: boolean;
}

export function parseLine(parser: LogParser, raw: string): ParsedLine {
  const match = new RegExp(parser.pattern).exec(raw);
  if (!match) {
    return { raw, time: null, type: null, id: null, event: null, matched: false };
  }
  const out: ParsedLine = { raw, time: null, type: null, id: null, event: null, matched: true };
  parser.groups.forEach((field, index) => {
    const value = match[index + 1] ?? null;
    if (field === 'time') out.time = value;
    else if (field === 'type') out.type = value;
    else if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
  });
  return out;
}

/**
 * The log's OWN timestamp is authoritative, never the ingestion time — replay
 * a year-old file and its consumption must land where it happened, not all on
 * one Tuesday afternoon.
 *
 * A time-only stamp (`12:40:32`) carries no date, so it is attached to
 * `dateHint` — the day the file is understood to cover.
 */
export function resolveTimestamp(time: string | null, dateHint: Date): Date {
  if (!time) return dateHint;

  const hms = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (hms) {
    const at = new Date(dateHint);
    at.setHours(Number(hms[1]), Number(hms[2]), Number(hms[3] ?? 0), 0);
    return at;
  }
  const parsed = new Date(time.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? dateHint : parsed;
}

// ---------------------------------------------------------------------------
// The dictionary, versioned by date
// ---------------------------------------------------------------------------

/** The effect list in force on a given day — not the one in force today. */
export function effectsInForce(eventId: string, at: Date): LogEffect[] | null {
  const seconds = Math.floor(at.getTime() / 1000);
  const row = db
    .select()
    .from(logEventVersions)
    .where(
      and(
        eq(logEventVersions.eventId, eventId),
        sql`${logEventVersions.validFrom} <= ${seconds}`,
        or(
          isNull(logEventVersions.validTo),
          sql`${logEventVersions.validTo} > ${seconds}`,
        ),
      ),
    )
    .orderBy(desc(logEventVersions.validFrom))
    .get();
  return row?.effects ?? null;
}

// ---------------------------------------------------------------------------
// Applying effects
// ---------------------------------------------------------------------------

/**
 * Charge a concept's open container, exactly as a recorded activity would —
 * moving the quantity as well as the claim, because says the log
 * can do nothing the UI cannot, and that cuts both ways: it must not do LESS
 * either, or the same event would mean two different things depending on
 * whether a person or the machine controller reported it.
 *
 * What it still may not do is close the container. There is nobody at the
 * keyboard to look inside the bottle, so an overdraw leaves a pending
 * decision rather than emptying anything.
 */
function consumeFromOpenContainer(conceptId: string, quantity: number): string | null {
  // The same picker the UI uses, not a second copy of the rule: which bottle a
  // charge lands on must not depend on who reported the work.
  const container = openContainerFor(conceptId);
  if (!container) return null;

  const nextRemaining =
    container.quantityRemaining === null
      ? null
      : Math.max(0, Math.round((container.quantityRemaining - quantity) * 1000) / 1000);

  db.update(items)
    .set({
      estimatedUsed: container.estimatedUsed + quantity,
      ...(nextRemaining === null ? {} : { quantityRemaining: nextRemaining }),
    })
    .where(eq(items.id, container.id))
    .run();
  return container.id;
}

function unitByCode(poolId: string, code: string) {
  return db
    .select()
    .from(poolUnits)
    .where(
      and(eq(poolUnits.poolId, poolId), eq(poolUnits.code, code), isNull(poolUnits.deletedAt)),
    )
    .get();
}

/** The tray currently being filled — one is filled at a time, physically. */
function activeUnit(poolId: string) {
  return db
    .select()
    .from(poolUnits)
    .where(
      and(eq(poolUnits.poolId, poolId), eq(poolUnits.state, 'in_use'), isNull(poolUnits.deletedAt)),
    )
    .orderBy(desc(poolUnits.updatedAt))
    .get();
}

export class UnknownObjectError extends Error {}

function applyEffect(effect: LogEffect, line: ParsedLine, at: Date): string {
  switch (effect.kind) {
    case 'pool_take':
    case 'pool_return':
    case 'pool_wash': {
      const kind = effect.kind === 'pool_take' ? 'take' : effect.kind === 'pool_return' ? 'return' : 'wash';
      applyPoolEvent(effect.poolId, kind, effect.quantity, {
        note: line.id ? `log: ${line.id}` : null,
        source: 'log',
      });
      return `${kind} ${effect.quantity}`;
    }

    case 'consume': {
      const itemId = consumeFromOpenContainer(effect.conceptId, effect.quantity);
      const concept = db.select().from(concepts).where(eq(concepts.id, effect.conceptId)).get();
      return itemId
        ? `charged ${effect.quantity} to an open ${concept?.humanId ?? 'container'}`
        : `no open container for ${concept?.humanId ?? effect.conceptId}`;
    }

    case 'record_action': {
      db.insert(actionRecords)
        .values({
          id: crypto.randomUUID(),
          actionId: effect.actionId,
          count: effect.count,
          occurredAt: at,
          userId: null,
          source: 'log',
        })
        .run();
      // The map in force ON THAT DAY, not today's.
      chargeAction(effect.actionId, effect.count, at);
      return `recorded ×${effect.count}`;
    }

    case 'occupancy_open': {
      const unit = activeUnit(effect.poolId);
      if (!unit) {
        throw new UnknownObjectError(
          'no tray is currently in use in that pool, so there is no slot to fill',
        );
      }
      // Kits are transient and there will be thousands — always created,
      // never queried back to a human ( asymmetry).
      db.insert(occupancies)
        .values({
          id: crypto.randomUUID(),
          unitId: unit.id,
          position: effect.position ?? null,
          sampleTag: line.id ?? 'unknown',
          openedAt: at,
        })
        .run();
      return `slot filled on ${unit.code}`;
    }

    case 'occupancy_close': {
      if (!line.id) throw new UnknownObjectError('the line carries no sample identifier');
      const open = db
        .select()
        .from(occupancies)
        .innerJoin(poolUnits, eq(occupancies.unitId, poolUnits.id))
        .where(
          and(
            eq(poolUnits.poolId, effect.poolId),
            eq(occupancies.sampleTag, line.id),
            isNull(occupancies.closedAt),
          ),
        )
        .get();
      if (!open) throw new UnknownObjectError(`no open slot holds ${line.id}`);
      db.update(occupancies)
        .set({ closedAt: at })
        .where(eq(occupancies.id, open.occupancies.id))
        .run();
      return 'slot emptied';
    }

    case 'unit_state': {
      if (!line.id) throw new UnknownObjectError('the line carries no object identifier');
      const unit = unitByCode(effect.poolId, line.id);
      // An asset the app has never heard of is PARKED, never auto-created —
      // that is how you end up with 400 phantom trays from one typo.
      if (!unit) throw new UnknownObjectError(`no unit '${line.id}' in that pool`);
      db.update(poolUnits).set({ state: effect.state }).where(eq(poolUnits.id, unit.id)).run();
      return `${unit.code} → ${effect.state}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const hashLine = (sourceId: string, raw: string, index: number) =>
  createHash('sha256').update(`${sourceId}|${index}|${raw}`).digest('hex');

export interface IngestOptions {
  /** Shadow the whole run regardless of per-event settings (dry run). */
  forceShadow?: boolean;
  /** The day a time-only stamp belongs to. */
  dateHint?: Date;
  /** Line offset for hashing, so a continuing read stays idempotent. */
  startIndex?: number;
}

/**
 * Ingest raw log content. Each line takes effect EXACTLY ONCE — the hash is
 * the idempotency key, so reprocessing a file never double-charges.
 */
export function ingestContent(
  sourceId: string,
  content: string,
  options: IngestOptions = {},
): IngestResult {
  const source = db.select().from(logSources).where(eq(logSources.id, sourceId)).get();
  if (!source) throw new Error(`log source ${sourceId} not found`);

  const dateHint = options.dateHint ?? new Date();
  const startIndex = options.startIndex ?? 0;
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const result: IngestResult = {
    read: lines.length,
    applied: 0,
    shadow: 0,
    unknownEvent: 0,
    unknownObject: 0,
    errors: 0,
    skipped: 0,
  };

  let lastAt: Date | null = null;

  lines.forEach((raw, offset) => {
    const lineHash = hashLine(sourceId, raw, startIndex + offset);
    const already = db.select().from(logLines).where(eq(logLines.lineHash, lineHash)).get();
    if (already) {
      result.skipped += 1;
      return;
    }

    const parsed = parseLine(source.parser, raw);
    const occurredAt = resolveTimestamp(parsed.time, dateHint);
    lastAt = occurredAt;

    const record = (status: string, detail: string | null) => {
      db.insert(logLines)
        .values({
          id: crypto.randomUUID(),
          sourceId,
          lineHash,
          raw,
          occurredAt,
          objectType: parsed.type,
          objectId: parsed.id,
          eventName: parsed.event,
          status: status as never,
          detail,
        })
        .run();
    };

    if (!parsed.matched || !parsed.event) {
      result.errors += 1;
      record('error', 'the line does not match this source\'s shape');
      return;
    }

    const def = db
      .select()
      .from(logEventDefs)
      .where(and(eq(logEventDefs.name, parsed.event), isNull(logEventDefs.deletedAt)))
      .get();

    // Not an error: this is the configuration screen. A name appears, you say
    // what it does, and it never appears again.
    if (!def) {
      result.unknownEvent += 1;
      record('unknown_event', null);
      return;
    }

    const effects = effectsInForce(def.id, occurredAt);
    if (!effects) {
      result.unknownEvent += 1;
      record('unknown_event', 'no version of this event was in force on that date');
      return;
    }

    // Shadow mode: matched and recorded, but nothing applied. Reviewed, then
    // enabled — the same pattern as the CSV import dry run.
    if (options.forceShadow || def.shadow || !source.enabled) {
      result.shadow += 1;
      record('shadow', effects.map((e) => e.kind).join(', '));
      return;
    }

    try {
      const details = effects.map((effect) => applyEffect(effect, parsed, occurredAt));
      result.applied += 1;
      record('applied', details.join('; '));
    } catch (error) {
      if (error instanceof UnknownObjectError) {
        result.unknownObject += 1;
        record('unknown_object', error.message);
      } else {
        result.errors += 1;
        record('error', error instanceof Error ? error.message : String(error));
      }
    }
  });

  db.update(logSources)
    .set({
      lastPolledAt: new Date(),
      ...(lastAt ? { lastLineAt: lastAt } : {}),
      cursorOffset: startIndex + lines.length,
    })
    .where(eq(logSources.id, sourceId))
    .run();

  if (result.applied > 0 || result.unknownObject > 0) {
    logEvent({
      entityType: 'logEvent',
      entityId: sourceId,
      entityHumanId: source.name,
      action: 'recorded',
      valueAfter: result,
      notes: 'log ingest',
      userId: LOG_ACTOR,
    });
  }

  return result;
}

/** Names nobody has explained yet — the main way the rule set gets built. */
export function unknownEvents() {
  const rows = db
    .select({
      eventName: logLines.eventName,
      n: sql<number>`count(*)`,
      firstSeen: sql<number>`min(${logLines.occurredAt})`,
      lastSeen: sql<number>`max(${logLines.occurredAt})`,
      sampleObjectType: sql<string>`max(${logLines.objectType})`,
      sampleRaw: sql<string>`max(${logLines.raw})`,
    })
    .from(logLines)
    .where(eq(logLines.status, 'unknown_event'))
    .groupBy(logLines.eventName)
    .orderBy(sql`count(*) desc`)
    .all();

  return rows
    .filter((row) => row.eventName)
    .map((row) => ({
      eventName: row.eventName!,
      count: Number(row.n),
      firstSeen: new Date(Number(row.firstSeen) * 1000).toISOString(),
      lastSeen: new Date(Number(row.lastSeen) * 1000).toISOString(),
      sampleObjectType: row.sampleObjectType ?? null,
      sampleRaw: row.sampleRaw ?? '',
    }));
}

/**
 * Silence is the failure mode that does not shout: nothing breaks, the numbers
 * just quietly stop being true.
 */
export function logHealth() {
  const sources = db
    .select()
    .from(logSources)
    .where(isNull(logSources.deletedAt))
    .all();
  const unknownByName = new Map(unknownEvents().map((u) => [u.eventName, u.count]));
  const totalUnknown = [...unknownByName.values()].reduce((a, b) => a + b, 0);

  return sources.map((source) => {
    const minutes = source.lastLineAt
      ? Math.round((Date.now() - source.lastLineAt.getTime()) / 60000)
      : null;
    return {
      sourceId: source.id,
      name: source.name,
      enabled: source.enabled,
      lastLineAt: source.lastLineAt ? source.lastLineAt.toISOString() : null,
      minutesSinceLastLine: minutes,
      silent: source.enabled && minutes !== null && minutes > source.silenceMinutes,
      unknownEvents: totalUnknown,
    };
  });
}

export function poolNamed(poolId: string) {
  return db.select().from(pools).where(eq(pools.id, poolId)).get();
}
