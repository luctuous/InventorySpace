import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiRequestError } from '../api/client';
import { useToast } from './toast';
import { Button, Modal } from './ui';
import { useI18n } from '../i18n';

// Deleting a catalogue level is refused while things hang off it. Rather than
// making the user delete four levels by hand, we show what the server said was
// in the way and offer to take it all down in one transaction.

interface CascadeCounts {
  analogous?: number;
  variants?: number;
  items?: number;
  locations?: number;
}

export interface DeleteTarget {
  label: string;
  onDelete: (cascade: boolean) => Promise<unknown>;
}

export function DeleteDialog({
  target,
  onClose,
}: {
  target: DeleteTarget | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [blocked, setBlocked] = useState<{ message: string; counts: CascadeCounts } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!target) return null;

  const run = async (cascade: boolean) => {
    setBusy(true);
    try {
      await target.onDelete(cascade);
      toast({ message: t('common.deleted'), variant: 'success' });
      close();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const details = error.details as { cascade?: CascadeCounts } | undefined;
        if (details?.cascade && !cascade) {
          // Offer the cascade instead of just reporting the refusal.
          setBlocked({ message: error.message, counts: details.cascade });
        } else {
          toast({ message: error.message, variant: 'danger' });
          close();
        }
      } else {
        toast({ message: String(error), variant: 'danger' });
        close();
      }
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setBlocked(null);
    onClose();
  };

  const parts = blocked
    ? ([
        ['nav.analogous', blocked.counts.analogous],
        ['nav.variants', blocked.counts.variants],
        ['nav.items', blocked.counts.items],
        ['nav.locations', blocked.counts.locations],
      ] as const).filter(([, n]) => (n ?? 0) > 0)
    : [];

  return (
    <Modal open onClose={close} title={blocked ? t('delete.blockedTitle') : t('delete.title')}>
      {blocked ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{blocked.message}</p>
          <div className="rounded-md border border-warning/40 bg-warning-tint p-3">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium text-warning">
              <AlertTriangle className="h-4 w-4" />
              {t('delete.cascadeIntro')}
            </p>
            <ul className="space-y-0.5 text-sm text-text">
              {parts.map(([key, n]) => (
                <li key={key} className="font-mono">
                  {n} × {t(key)}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted">{t('delete.cascadeNote')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(true)}>
              {t('delete.cascadeConfirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text">
            {t('delete.confirm')} <span className="human-id">{target.label}</span>
          </p>
          <p className="text-xs text-muted">{t('delete.softNote')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(false)}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
