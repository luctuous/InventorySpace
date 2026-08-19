import { useState } from 'react';
import { Lock, RotateCcw, Trash2 } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import type { TrashRow } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { usePurge, useRestore, useTrash } from '../api/entities';
import { useToast } from '../components/toast';
import { Button, FieldError, Input, Label, Modal, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { formatDateTime } from '../lib/format';

// Deleting is always soft, so everything you removed is still
// here and can come back. Restores go parent-first: a variant cannot return
// into an analogous group that is itself still deleted, and the list says so
// rather than letting you find out by clicking.
//
// This is also the only place anything is ever destroyed for good.

export function TrashPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const trashQuery = useTrash(true);
  const restore = useRestore();
  const purge = usePurge();
  const [purging, setPurging] = useState<TrashRow | null>(null);

  const onRestore = async (row: TrashRow) => {
    try {
      const result = await restore.mutateAsync({ entityType: row.entityType, id: row.id });
      toast({ message: `${result.humanId} · ${t('trash.restored')}`, variant: 'success' });
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  if (trashQuery.isPending) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  const rows = trashQuery.data ?? [];

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold text-text">{t('trash.title')}</h1>
      <p className="mb-5 max-w-2xl text-sm text-muted">{t('trash.intro')}</p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line py-16 text-center">
          <Trash2 className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="text-sm text-muted">{t('trash.empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">{t('history.entity')}</th>
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">{t('concepts.nameLabel')}</th>
                <th className="px-4 py-2.5 font-medium">{t('trash.deletedAt')}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.entityType}-${row.id}`}
                  className="border-b border-line last:border-0 hover:bg-surface"
                >
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {t(`history.entities.${row.entityType}`)}
                  </td>
                  <td className="px-4 py-2.5"><span className="human-id">{row.humanId}</span></td>
                  <td className="px-4 py-2.5 text-text">{resolveText(row.label, locale) || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">
                    {formatDateTime(row.deletedAt, locale)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      {row.blockedBy ? (
                        <span
                          className="inline-flex items-center gap-1.5 text-xs text-muted"
                          title={t('trash.blockedHint')}
                        >
                          <Lock className="h-3.5 w-3.5" />
                          {t('trash.blockedBy').replace('{parent}', row.blockedBy)}
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void onRestore(row)}>
                          <RotateCcw className="h-3.5 w-3.5" /> {t('trash.restore')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('trash.purge')}
                        onClick={() => setPurging(row)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {purging && (
        <PurgeModal
          row={purging}
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            try {
              const result = await purge.mutateAsync({
                entityType: purging.entityType,
                id: purging.id,
              });
              toast({ message: `${result.humanId} · ${t('trash.purged')}`, variant: 'success' });
              setPurging(null);
            } catch (error) {
              throw error instanceof ApiRequestError ? error : new Error(String(error));
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Typing the id is the confirmation. A yes/no dialog for something with no
 * undo is too easy to click through by muscle memory.
 */
function PurgeModal({
  row,
  onClose,
  onConfirm,
}: {
  row: TrashRow;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === row.humanId;

  return (
    <Modal open onClose={onClose} title={t('trash.purge')}>
      <div className="space-y-3">
        <p className="text-sm text-text">
          {resolveText(row.label, locale) || row.humanId}
        </p>
        <p className="text-sm text-muted">{t('trash.purgeWarning')}</p>
        <div>
          <Label htmlFor="purge-confirm">
            {t('trash.purgeConfirm', { humanId: row.humanId })}
          </Label>
          <Input
            id="purge-confirm"
            value={typed}
            autoFocus
            autoComplete="off"
            onChange={(e) => { setTyped(e.target.value); setError(null); }}
          />
        </div>
        <FieldError message={error ?? undefined} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={!matches || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 className="h-4 w-4" /> {t('trash.purge')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
