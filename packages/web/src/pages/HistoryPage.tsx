import { useState } from 'react';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, resolveText, roleAtLeast } from '@inventory/shared';
import type { AuditAction, AuditEntity } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { useUsers } from '../api/entities';
import { useHistory } from '../api/history';
import type { HistoryRow } from '../api/history';
import { Input, Pagination, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';

// Reverse-chronological audit feed with filters.

const actionStyle: Record<AuditAction, string> = {
  created: 'bg-success-tint text-success',
  updated: 'bg-primary-tint text-primary',
  status_changed: 'bg-warning-tint text-warning',
  moved: 'bg-secondary-tint text-secondary',
  quantity_adjusted: 'bg-accent-tint text-accent',
  soft_deleted: 'bg-danger-tint text-danger',
  restored: 'bg-success-tint text-success',
  //
  ordered: 'bg-secondary-tint text-secondary',
  received: 'bg-success-tint text-success',
  reconciled: 'bg-accent-tint text-accent',
  recounted: 'bg-accent-tint text-accent',
  recorded: 'bg-primary-tint text-primary',
  commissioned: 'bg-success-tint text-success',
  retired: 'bg-danger-tint text-danger',
  purged: 'bg-danger-tint text-danger',
  serviced: 'bg-success-tint text-success',
  linked: 'bg-secondary-tint text-secondary',
  unlinked: 'bg-muted/15 text-muted',
};

/**
 * A history row is meant to be read, so a raw `{"count":3}` is a failure: it
 * makes you decode the database to answer "what happened". Values are unpacked
 * into words, and only fall back to JSON when there is genuinely no better way
 * to show them.
 */
function readable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return value.length === 1 ? '1 line' : `${value.length} lines`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== '',
    );
    if (entries.length === 0) return null;
    // Single-key objects are the common case ({count: 3}, {supplier: "Northline"})
    // and read best as just the value.
    if (entries.length === 1) {
      const [key, only] = entries[0]!;
      const shown = readable(only);
      if (shown === null) return null;
      return key === 'name' || key === 'supplier' ? shown : `${key} ${shown}`;
    }
    return entries
      .map(([key, v]) => `${key} ${readable(v) ?? '—'}`)
      .join(' · ');
  }
  return null;
}

function clamp(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ChangeCell({ entry }: { entry: HistoryRow }) {
  const before = readable(entry.valueBefore);
  const after = readable(entry.valueAfter);

  // Nothing to show beyond the action itself — the row already says it all.
  if (before === null && after === null && !entry.notes) {
    return <span className="text-muted">—</span>;
  }

  return (
    <span className="text-xs">
      {entry.fieldChanged && <span className="text-muted">{entry.fieldChanged}: </span>}
      {before !== null && (
        <>
          <span className="font-mono text-danger/80">{clamp(before)}</span>
          <span className="text-muted"> → </span>
        </>
      )}
      {after !== null && <span className="font-mono text-success/80">{clamp(after)}</span>}
      {entry.notes && (
        <span className="ml-2 text-muted">{clamp(entry.notes, 60)}</span>
      )}
    </span>
  );
}

export function HistoryPage() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<AuditEntity | ''>('');
  const [action, setAction] = useState<AuditAction | ''>('');
  const [userId, setUserId] = useState('');
  const [q, setQ] = useState('');

  const { data: session } = authClient.useSession();
  const isAdmin = session ? roleAtLeast(asSessionUser(session.user).role, 'admin') : false;
  // Only admins can list users, so only they get the "who did it" filter.
  const usersQuery = useUsers(isAdmin);

  const historyQuery = useHistory({
    page,
    entityType: entityType || undefined,
    action: action || undefined,
    userId: userId || undefined,
    q,
  });

  const reset = () => setPage(1);

  return (
    <div>
      <h1 className="mb-5 text-2xl font-semibold text-text">{t('history.title')}</h1>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          value={entityType}
          onChange={(e) => { setEntityType(e.target.value as AuditEntity | ''); reset(); }}
        >
          <option value="">{t('history.allEntities')}</option>
          {AUDIT_ENTITIES.map((entity) => (
            <option key={entity} value={entity}>{t(`history.entities.${entity}`)}</option>
          ))}
        </Select>
        <Select value={action} onChange={(e) => { setAction(e.target.value as AuditAction | ''); reset(); }}>
          <option value="">{t('history.allActions')}</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>{t(`history.actions.${a}`)}</option>
          ))}
        </Select>
        {isAdmin && (
          <Select value={userId} onChange={(e) => { setUserId(e.target.value); reset(); }}>
            <option value="">{t('history.allUsers')}</option>
            {usersQuery.data?.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        )}
        <Input
          placeholder={t('history.searchPlaceholder')}
          value={q}
          onChange={(e) => { setQ(e.target.value); reset(); }}
        />
      </div>

      {historyQuery.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">{t('history.time')}</th>
                <th className="px-4 py-2.5 font-medium">{t('history.action')}</th>
                <th className="px-4 py-2.5 font-medium">{t('history.entity')}</th>
                <th className="px-4 py-2.5 font-medium">{t('history.change')}</th>
                <th className="px-4 py-2.5 font-medium">{t('history.user')}</th>
              </tr>
            </thead>
            <tbody>
              {historyQuery.data?.data.map((entry) => (
                <tr key={entry.id} className="border-b border-line last:border-0 hover:bg-surface">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                    {formatDateTime(entry.createdAt, locale)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide whitespace-nowrap',
                      actionStyle[entry.action],
                    )}>
                      {t(`history.actions.${entry.action}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">
                        {t(`history.entities.${entry.entityType}`)}
                      </span>
                      {entry.entityHumanId && (
                        <span className="human-id">{entry.entityHumanId}</span>
                      )}
                    </div>
                    {/* The name, so the row reads without decoding an id. */}
                    {entry.entityName && (
                      <span className="block truncate text-xs text-text">
                        {resolveText(entry.entityName, locale)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5"><ChangeCell entry={entry} /></td>
                  <td className="px-4 py-2.5 text-xs text-muted">{entry.userName ?? '—'}</td>
                </tr>
              ))}
              {historyQuery.data?.data.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-muted">{t('common.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={historyQuery.data?.meta.totalPages ?? 1} onPage={setPage} />
    </div>
  );
}
