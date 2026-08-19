import { useEffect, useState } from 'react';
import { resolveText } from '@inventory/shared';
import type { RequestUrgency } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useConceptOptions } from '../api/concepts';
import { useConceptStockMap } from '../api/entities';
import { useCreateRequest, useOpenRequestFor, useSupportRequest } from '../api/operations';
import { useI18n } from '../i18n';
import { Combobox } from './Combobox';
import { useToast } from './toast';
import { Button, FieldError, Input, Label, Modal, Select, Textarea } from './ui';

// The Request form. Deliberately tiny: what, and how much.
// The person who needs wood glue must not have to know which brand — that is
// exactly what the Concept level is for.

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-selected when the modal is opened from a depleted item. */
  conceptId?: string | null;
  suggestedQuantity?: number | null;
}

export function RequestModal({ open, onClose, conceptId = null, suggestedQuantity }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const conceptsQuery = useConceptOptions();
  const stockMap = useConceptStockMap();
  const createRequest = useCreateRequest();
  const support = useSupportRequest();

  const [selected, setSelected] = useState<string>(conceptId ?? '');
  const [quantity, setQuantity] = useState<string>(String(suggestedQuantity ?? 1));
  const [urgency, setUrgency] = useState<RequestUrgency>('normal');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(conceptId ?? '');
    setQuantity(String(suggestedQuantity ?? 1));
    setUrgency('normal');
    setNote('');
    setError(null);
  }, [open, conceptId, suggestedQuantity]);

  // Someone may already have asked. A +1 is better data than a duplicate row:
  // it records demand intensity instead of losing it.
  const existingQuery = useOpenRequestFor(open && selected ? selected : null);
  const existing = existingQuery.data?.request ?? null;

  const concepts = conceptsQuery.data ?? [];
  const concept = concepts.find((c) => c.id === selected) ?? null;
  // The options list is deliberately name-only; the stock figure beside each
  // one comes from the map Home already keeps warm.
  const stockFor = (conceptId_: string) => stockMap.data?.[conceptId_] ?? 0;

  const submit = async () => {
    setError(null);
    const parsed = Number(quantity);
    if (!selected || !Number.isFinite(parsed) || parsed <= 0) {
      setError(t('requests.quantity'));
      return;
    }
    try {
      const created = await createRequest.mutateAsync({
        conceptId: selected,
        quantity: parsed,
        urgency,
        note: note.trim() || null,
      });
      toast({ message: t('requests.created', { humanId: created.humanId }), variant: 'success' });
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  const joinExisting = async () => {
    if (!existing) return;
    await support.mutateAsync(existing.id);
    toast({ message: t('requests.joined'), variant: 'success' });
    onClose();
  };

  const daysAgo = existing
    ? Math.max(0, Math.round((Date.now() - new Date(existing.createdAt).getTime()) / 86_400_000))
    : 0;

  return (
    <Modal open={open} onClose={onClose} title={t('requests.new')}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="req-concept">{t('requests.concept')}</Label>
          {/* Searchable, and reading the full list rather than a page of it:
              a dropdown that silently stops at the first 25 concepts makes the
              ones after that look like things the workshop does not have. */}
          <Combobox
            id="req-concept"
            value={selected}
            onChange={setSelected}
            placeholder={t('common.typeToSearch')}
            options={concepts.map((row) => ({
              value: row.id,
              label: resolveText(row.name, locale),
              hint: `${row.humanId} · ${stockFor(row.id)} ${row.unit}`,
            }))}
          />
        </div>

        {existing && (
          <div className="rounded-lg border border-secondary/40 bg-secondary-tint p-3">
            <p className="text-sm text-text">
              {t('requests.alsoAsked', {
                name: existing.requesterName ?? '—',
                days: daysAgo,
              })}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted">
              {existing.humanId} · {existing.quantity} {existing.conceptUnit}
              {existing.supporters.length > 0 &&
                ` · ${t('requests.supporters', { n: existing.supporters.length })}`}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={joinExisting}
              disabled={support.isPending}
            >
              {t('requests.addMeToo')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="req-qty">{t('requests.quantity')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="req-qty"
                type="number"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <span className="whitespace-nowrap text-sm text-muted">{concept?.unit ?? ''}</span>
            </div>
          </div>
          <div>
            <Label htmlFor="req-urgency">{t('requests.urgency')}</Label>
            {/* Two levels, not five. With five, everything is urgent inside a month. */}
            <Select
              id="req-urgency"
              value={urgency}
              onChange={(e) => setUrgency(e.target.value as RequestUrgency)}
            >
              <option value="normal">{t('requests.normal')}</option>
              <option value="blocking">{t('requests.blocking')}</option>
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="req-note">{t('requests.note')}</Label>
          <Textarea id="req-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={createRequest.isPending || !selected}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
