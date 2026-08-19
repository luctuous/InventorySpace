import type { AuditAction, AuditEntity } from '@inventory/shared';
import { db } from '../db/client';
import { history } from '../db/schema';

export interface LogEventInput {
  entityType: AuditEntity;
  entityId: string;
  entityHumanId?: string | null;
  action: AuditAction;
  fieldChanged?: string | null;
  valueBefore?: unknown;
  valueAfter?: unknown;
  notes?: string | null;
  userId?: string | null;
}

/**
 * Nothing important happens without a trace.
 * Call inside the same transaction as the mutation it records.
 */
export function logEvent(event: LogEventInput): void {
  db.insert(history)
    .values({
      id: crypto.randomUUID(),
      entityType: event.entityType,
      entityId: event.entityId,
      entityHumanId: event.entityHumanId ?? null,
      action: event.action,
      fieldChanged: event.fieldChanged ?? null,
      valueBefore: event.valueBefore ?? null,
      valueAfter: event.valueAfter ?? null,
      notes: event.notes ?? null,
      userId: event.userId ?? null,
    })
    .run();
}
