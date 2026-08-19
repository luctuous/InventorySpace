import { useEffect, useState } from 'react';
import { Check, Plus, TriangleAlert } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import type { RequestWithRefs } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useConceptOptions } from '../api/concepts';
import { useTypes } from '../api/entities';
import { useAddLotLine, useVariantSuggestions } from '../api/operations';
import type { VariantSuggestion } from '../api/operations';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDate, formatPrice } from '../lib/format';
import { Combobox } from './Combobox';
import { Button, FieldError, Input, Label, Modal, Select } from './ui';

// Resolving a lot line: a line arrives as "Wood glue, 500 mL"
// and must leave as "1 × 1 L bottle of brand X, 34.50 €". The screen's job is
// to make that nearly automatic, because most reorders are repeats.
//
// The hard part is the seam between the two halves of the model. A Request is
// Concept-level on purpose — the person who needs wood glue must not have to
// know which brand — and a lot line is Variant-level, because that is what a
// supplier can actually send. Everything below exists to make crossing that
// seam a decision the buyer makes on purpose, once, and never has to repeat.

interface Props {
  open: boolean;
  onClose: () => void;
  lotId: string;
  /** Requests being satisfied — they set the concept and the quantity needed. */
  seedRequests?: RequestWithRefs[];
}

/**
 * Whether the pack maths can be trusted.
 *
 * `ceil(needed / packSize)` is only arithmetic if both numbers are in the same
 * unit, and nothing enforces that: a request is in the Concept's unit and a
 * pack is in whatever the supplier prints on the bottle. A 500 mL request
 * against a 1 L bottle used to quietly propose ordering five hundred bottles.
 * When the units do not match, the screen says so and leaves the quantity
 * alone — a buyer who can see both numbers will get it right in two seconds.
 */
function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function LotLineForm({ open, onClose, lotId, seedRequests = [] }: Props) {
  const { t, locale } = useI18n();
  const conceptOptions = useConceptOptions();
  const typesQuery = useTypes();
  const addLine = useAddLotLine();

  // Every seeded request is for one concept — LotsPage refuses to hand over a
  // mixed selection — so the first one speaks for all of them.
  const seedConceptId = seedRequests[0]?.conceptId ?? '';
  const needed = seedRequests.reduce((sum, request) => sum + request.quantity, 0);
  const requestUnit = seedRequests[0]?.unit ?? seedRequests[0]?.conceptUnit ?? null;
  /** What the requester asked for by name, if they named anything. */
  const hintVariantId = seedRequests.find((request) => request.hintVariantId)?.hintVariantId ?? null;

  const [conceptId, setConceptId] = useState(seedConceptId);
  const [variantId, setVariantId] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newTypeId, setNewTypeId] = useState('');
  const [newPackSize, setNewPackSize] = useState('');
  const [newPackUnit, setNewPackUnit] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const suggestionsQuery = useVariantSuggestions(open && conceptId ? conceptId : null);
  const suggestions = suggestionsQuery.data ?? [];
  const chosen = suggestions.find((row) => row.variantId === variantId) ?? null;

  // Bought before, and merely defined. They are different offers: one is "the
  // same as last time, at last time's price", the other is "this exists".
  const bought = suggestions.filter((row) => row.timesPurchased > 0);
  const untouched = suggestions.filter((row) => row.timesPurchased === 0);

  const concept = conceptOptions.data?.find((row) => row.id === conceptId) ?? null;
  const packUnit = chosen?.packUnit ?? null;
  const unitsAgree = sameUnit(requestUnit, packUnit);

  useEffect(() => {
    if (!open) return;
    setConceptId(seedConceptId);
    setVariantId('');
    setCreating(false);
    setNewName('');
    setNewBrand('');
    setNewTypeId('');
    setNewPackSize('');
    setNewPackUnit('');
    setQuantity('1');
    setPrice('');
    setError(null);
  }, [open, seedConceptId]);

  /**
   * Open on the obvious answer.
   *
   * In order: what the requester actually asked for, then what was bought last
   * time. Both were already in the database and neither was ever shown here —
   * the form used to open on nothing at all and make the buyer re-derive a
   * decision somebody else had already made.
   */
  useEffect(() => {
    if (!open || variantId !== '' || creating || suggestions.length === 0) return;
    const hinted = hintVariantId
      ? suggestions.find((row) => row.variantId === hintVariantId)
      : undefined;
    const preferred = hinted ?? suggestions.find((row) => row.timesPurchased > 0);
    if (preferred) pickSuggestion(preferred);
    // Only when the list arrives, never on every keystroke afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestions.length]);

  /** One click: the same product, at the price it cost last time. */
  const pickSuggestion = (suggestion: VariantSuggestion) => {
    setCreating(false);
    setVariantId(suggestion.variantId);
    if (suggestion.lastPriceAmount !== null) {
      setPrice((suggestion.lastPriceAmount / 100).toFixed(2));
    }
    // Proposed, and only when the arithmetic is honest — see sameUnit above.
    if (
      needed > 0 &&
      suggestion.packSize &&
      suggestion.packSize > 0 &&
      sameUnit(requestUnit, suggestion.packUnit)
    ) {
      setQuantity(String(Math.ceil(needed / suggestion.packSize)));
    }
  };

  const startCreating = () => {
    setCreating(true);
    setVariantId('');
    setPrice('');
    // A concept with products already tells us what kind of thing this is; the
    // type only has to be asked for when there is nothing to copy.
    setNewPackUnit(requestUnit ?? concept?.unit ?? '');
  };

  const typeNeeded = creating && suggestions.length === 0;
  const canSubmit =
    conceptId !== '' &&
    Number(quantity) > 0 &&
    (creating ? newName.trim() !== '' && (!typeNeeded || newTypeId !== '') : variantId !== '');

  const submit = async () => {
    setError(null);
    const qty = Number(quantity);
    if (!canSubmit || !Number.isFinite(qty)) {
      setError(t('lots.pickOrCreate'));
      return;
    }
    try {
      await addLine.mutateAsync({
        lotId,
        body: {
          conceptId,
          ...(creating
            ? {
                newVariantName: newName.trim(),
                newVariantBrand: newBrand.trim() || null,
                newVariantTypeId: newTypeId || undefined,
                newVariantPackSize: newPackSize ? Number(newPackSize) : null,
                newVariantPackUnit: newPackUnit.trim() || null,
              }
            : { orderedVariantId: variantId }),
          orderedQuantity: qty,
          unitPrice: price.trim() || undefined,
          requestIds: seedRequests.map((request) => request.id),
        },
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : String(caught));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('lots.addLine')}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="line-concept">{t('requests.concept')}</Label>
          {/* Locked when requests seeded it: the line exists to answer those
              requests, and swapping the concept underneath them would attach
              them to something nobody asked for. */}
          <Combobox
            id="line-concept"
            value={conceptId}
            onChange={(next) => {
              setConceptId(next);
              setVariantId('');
              setCreating(false);
            }}
            placeholder={t('common.typeToSearch')}
            allowClear={seedRequests.length === 0}
            disabled={seedRequests.length > 0}
            options={(conceptOptions.data ?? []).map((row) => ({
              value: row.id,
              label: resolveText(row.name, locale),
              hint: row.humanId,
            }))}
          />
          {needed > 0 && (
            <p className="mt-1 text-xs text-muted">
              {t('lots.requested')}: {needed} {requestUnit ?? ''} ·{' '}
              {seedRequests.length} × {t('requests.title').toLowerCase()}
            </p>
          )}
        </div>

        {conceptId && (
          <div>
            <Label>{t('lots.chooseVariant')}</Label>

            {suggestions.length === 0 ? (
              <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
                {t('lots.noVariantsYet')}
              </p>
            ) : (
              <div className="space-y-1.5">
                {bought.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.variantId}
                    suggestion={suggestion}
                    selected={variantId === suggestion.variantId}
                    hinted={suggestion.variantId === hintVariantId}
                    onPick={() => pickSuggestion(suggestion)}
                  />
                ))}
                {untouched.length > 0 && (
                  <>
                    <p className="pt-1 text-[0.7rem] font-medium uppercase tracking-wide text-muted">
                      {t('lots.neverOrdered')}
                    </p>
                    {untouched.map((suggestion) => (
                      <SuggestionRow
                        key={suggestion.variantId}
                        suggestion={suggestion}
                        selected={variantId === suggestion.variantId}
                        hinted={suggestion.variantId === hintVariantId}
                        onPick={() => pickSuggestion(suggestion)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {!creating && (
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={startCreating}>
                <Plus className="h-4 w-4" /> {t('lots.newVariantHere')}
              </Button>
            )}
          </div>
        )}

        {creating && (
          <div className="space-y-3 rounded-lg border border-primary/40 bg-primary-tint/40 p-3">
            <div>
              <Label htmlFor="line-new-name">{t('lots.newVariantName')}</Label>
              <Input
                id="line-new-name"
                autoFocus
                placeholder="Bondwell wood glue D3, 750 mL"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
              <p className="mt-1 text-xs text-muted">{t('lots.newVariantHint')}</p>
            </div>
            {typeNeeded && (
              // Only asked for when there is no sibling product to copy it
              // from — the first product under a brand-new concept.
              <div>
                <Label htmlFor="line-new-type">{t('nav.types')}</Label>
                <Select
                  id="line-new-type"
                  value={newTypeId}
                  onChange={(event) => setNewTypeId(event.target.value)}
                >
                  <option value="">—</option>
                  {typesQuery.data?.map((type) => (
                    <option key={type.id} value={type.id}>
                      {resolveText(type.name, locale)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-3 sm:col-span-1">
                <Label htmlFor="line-new-brand">{t('variants.brand')}</Label>
                <Input
                  id="line-new-brand"
                  value={newBrand}
                  onChange={(event) => setNewBrand(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="line-new-pack">{t('variants.packSize')}</Label>
                <Input
                  id="line-new-pack"
                  type="number"
                  step="any"
                  min="0"
                  value={newPackSize}
                  onChange={(event) => setNewPackSize(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="line-new-unit">{t('variants.packUnit')}</Label>
                <Input
                  id="line-new-unit"
                  value={newPackUnit}
                  onChange={(event) => setNewPackUnit(event.target.value)}
                />
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="line-qty">{t('common.quantity')}</Label>
            <Input
              id="line-qty"
              type="number"
              step="any"
              min="0"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="line-price">{t('lots.unitPrice')}</Label>
            <Input
              id="line-price"
              inputMode="decimal"
              placeholder="34.50"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>
        </div>

        {/* The rounding is shown, not silently applied. */}
        {chosen?.packSize && needed > 0 && unitsAgree && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            {t('lots.packMath', {
              need: needed,
              unit: requestUnit ?? '',
              pack: `${chosen.packSize} ${chosen.packUnit ?? ''}`,
              qty: quantity,
            })}
          </p>
        )}
        {chosen?.packSize && needed > 0 && !unitsAgree && (
          <p className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('lots.unitMismatch', {
              requestUnit: requestUnit ?? '—',
              packUnit: packUnit ?? '—',
            })}
          </p>
        )}
        {chosen && !chosen.packSize && needed > 0 && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            {t('lots.packUnknown')}
          </p>
        )}

        {chosen?.lastPriceAmount != null && price.trim() !== '' && (
          <PriceDelta last={chosen.lastPriceAmount} current={price} currency={chosen.lastPriceCurrency} />
        )}

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={addLine.isPending || !canSubmit}>
            <Check className="h-4 w-4" />
            {t('common.add')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  hinted,
  onPick,
}: {
  suggestion: VariantSuggestion;
  selected: boolean;
  hinted: boolean;
  onPick: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary-tint' : 'border-line hover:bg-surface-2',
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm text-text">
          {resolveText(suggestion.name, locale)}
          {/* Somebody wrote down which one they wanted. Losing that and making
              them ask again is the rudest thing this screen could do. */}
          {hinted && (
            <span className="ml-2 rounded-sm bg-secondary-tint px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-secondary">
              {t('lots.hinted')}
            </span>
          )}
        </span>
        <span className="block font-mono text-xs text-muted">
          {suggestion.packSize
            ? `${suggestion.packSize} ${suggestion.packUnit ?? ''}`
            : suggestion.humanId}
          {suggestion.timesPurchased > 0 &&
            ` · ${t('lots.timesBought', { n: suggestion.timesPurchased })}`}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm tabular-nums text-text">
          {formatPrice(suggestion.lastPriceAmount, suggestion.lastPriceCurrency, locale)}
        </span>
        {suggestion.lastPurchasedAt && (
          <span className="block text-xs text-muted">
            {formatDate(suggestion.lastPurchasedAt, locale)}
          </span>
        )}
      </span>
    </button>
  );
}

/** "+12% since your last order" — at the moment of the decision, not in a report. */
function PriceDelta({
  last,
  current,
  currency,
}: {
  last: number;
  current: string;
  currency: string | null;
}) {
  const { t, locale } = useI18n();
  const parsed = Number(current.replace(',', '.'));
  if (!Number.isFinite(parsed) || last === 0) return null;
  const pct = Math.round(((parsed * 100 - last) / last) * 1000) / 10;
  if (pct === 0) return null;
  return (
    <p className={cn('text-xs', pct > 0 ? 'text-danger' : 'text-success')}>
      {pct > 0 ? t('lots.priceUp', { pct }) : t('lots.priceDown', { pct })} ·{' '}
      <span className="text-muted">
        {t('lots.lastPrice')} {formatPrice(last, currency, locale)}
      </span>
    </p>
  );
}
