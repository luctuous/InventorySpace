import { useEffect, useState } from 'react';
import { PackageCheck, Printer } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import type { LotWithLines } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useReceiveLot } from '../api/operations';
import type { ReceiveLineInput, ReceiveResultView } from '../api/operations';
import { LocationPicker } from './LocationPicker';
import { useI18n } from '../i18n';
import { Button, FieldError, Input, Label, Modal } from './ui';

// Reception — the payoff. Twelve bottles without typing
// twelve items. Three details decide whether it is pleasant or hateful:
// partial delivery is normal, one expiry per line, and labels at the end.

interface Props {
  open: boolean;
  onClose: () => void;
  lot: LotWithLines;
  onReceived: (result: ReceiveResultView) => void;
}

interface Draft {
  quantity: string;
  substituted: boolean;
  newVariantName: string;
  locationId: string | null;
  expiryDate: string;
  batchNumber: string;
  closeRemainder: boolean;
}

export function ReceiveModal({ open, onClose, lot, onReceived }: Props) {
  const { t, locale } = useI18n();
  const receive = useReceiveLot();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);

  const pending = lot.lines.filter(
    (line) => line.status === 'pending' || line.status === 'partial',
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDrafts(
      Object.fromEntries(
        pending.map((line) => [
          line.id,
          {
            // Default to the outstanding amount, which is the common case.
            quantity: String(Math.max(0, line.orderedQuantity - line.receivedQuantity)),
            substituted: false,
            newVariantName: '',
            locationId: line.locationId,
            expiryDate: '',
            batchNumber: '',
            closeRemainder: false,
          },
        ]),
      ),
    );
    // `pending` is derived from `lot`, which is the real dependency.
  }, [open, lot]);

  const patch = (id: string, next: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...next } }));

  const submit = async () => {
    setError(null);
    const lines: ReceiveLineInput[] = pending
      .map((line): ReceiveLineInput | null => {
        const draft = drafts[line.id];
        if (!draft) return null;
        const quantity = Number(draft.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) return null;
        if (quantity === 0 && !draft.closeRemainder) return null;
        return {
          lineId: line.id,
          quantity,
          newVariantName:
            draft.substituted && draft.newVariantName.trim()
              ? draft.newVariantName.trim()
              : undefined,
          locationId: draft.locationId ?? undefined,
          expiryDate: draft.expiryDate
            ? new Date(`${draft.expiryDate}T00:00:00`).toISOString()
            : undefined,
          batchNumber: draft.batchNumber.trim() || undefined,
          closeRemainder: draft.closeRemainder,
        };
      })
      .filter((line): line is ReceiveLineInput => line !== null);

    if (lines.length === 0) {
      setError(t('lots.howMany'));
      return;
    }

    try {
      const result = await receive.mutateAsync({ lotId: lot.id, lines });
      onReceived(result);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('lots.receive')}>
      <div className="space-y-4">
        {pending.map((line) => {
          const draft = drafts[line.id];
          if (!draft) return null;
          const outstanding = line.orderedQuantity - line.receivedQuantity;
          return (
            <div key={line.id} className="rounded-lg border border-line p-3">
              <p className="text-sm font-medium text-text">
                {resolveText(line.orderedVariantName, locale)}
              </p>
              <p className="mb-2 font-mono text-xs text-muted">
                {t('lots.ordered')} {line.orderedQuantity}
                {line.receivedQuantity > 0 && ` · ${t('lots.received')} ${line.receivedQuantity}`}
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor={`q-${line.id}`}>{t('lots.howMany')}</Label>
                  <Input
                    id={`q-${line.id}`}
                    type="number"
                    step="any"
                    min="0"
                    value={draft.quantity}
                    onChange={(e) => patch(line.id, { quantity: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`e-${line.id}`}>{t('lots.expiry')}</Label>
                  <Input
                    id={`e-${line.id}`}
                    type="date"
                    value={draft.expiryDate}
                    onChange={(e) => patch(line.id, { expiryDate: e.target.value })}
                  />
                </div>
              </div>

              <div className="mt-2">
                <Label>{t('items.location')}</Label>
                <LocationPicker
                  value={draft.locationId}
                  onChange={(id) => patch(line.id, { locationId: id })}
                />
              </div>

              <div className="mt-2">
                <Label htmlFor={`b-${line.id}`}>{t('lots.batch')}</Label>
                <Input
                  id={`b-${line.id}`}
                  value={draft.batchNumber}
                  onChange={(e) => patch(line.id, { batchNumber: e.target.value })}
                />
              </div>

              <label className="mt-2.5 flex items-center gap-2 text-sm text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.substituted}
                  onChange={(e) => patch(line.id, { substituted: e.target.checked })}
                />
                {t('lots.substituted')}
              </label>
              {draft.substituted && (
                <Input
                  className="mt-1.5"
                  placeholder={t('lots.newVariant')}
                  value={draft.newVariantName}
                  onChange={(e) => patch(line.id, { newVariantName: e.target.value })}
                />
              )}

              {/* Partial delivery is normal, not an error — but you need an
                  escape to stop waiting for the rest. */}
              {Number(draft.quantity) < outstanding && (
                <label className="mt-2 flex items-center gap-2 text-sm text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.closeRemainder}
                    onChange={(e) => patch(line.id, { closeRemainder: e.target.checked })}
                  />
                  {t('lots.closeRemainder')}
                </label>
              )}
            </div>
          );
        })}

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={receive.isPending}>
            <PackageCheck className="h-4 w-4" />
            {t('lots.receive')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Shown after a reception: the loop closes straight into the label sheet. */
export function ReceivedSummary({
  result,
  onPrint,
}: {
  result: ReceiveResultView;
  onPrint: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-success/40 bg-success-tint p-3">
      <p className="text-sm text-text">{t('lots.itemsCreated', { n: result.itemsCreated })}</p>
      {result.discrepancies.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {result.discrepancies.map((d, index) => (
            <li key={index} className="font-mono text-xs text-warning">
              {t(`lots.${d.kind === 'substituted' ? 'substituted' : d.kind}`)}: {d.detail}
            </li>
          ))}
        </ul>
      )}
      {result.itemsCreated > 0 && (
        <Button size="sm" variant="outline" className="mt-2" onClick={onPrint}>
          <Printer className="h-4 w-4" />
          {t('lots.printLabels', { n: result.itemsCreated })}
        </Button>
      )}
    </div>
  );
}
