import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Sparkles } from 'lucide-react';
import { parseMoneyInput, resolveText } from '@inventory/shared';
import type { QuickSearchResult } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useQuickAdd, useQuickSearch, useTypes } from '../api/entities';
import { CustomFields } from './CustomFields';
import { LocationPicker } from './LocationPicker';
import { useToast } from './toast';
import { Button, Input, Label, Modal, Select } from './ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// Quick Add: the ignorable hierarchy in practice.
// Optimized for "I'm standing in the storeroom holding the thing" — the modal
// stays open after submit and remembers the last Type and Location, because
// batch entry is the normal case.

const LAST_TYPE_KEY = 'quickadd-last-type';
const LAST_LOCATION_KEY = 'quickadd-last-location';

type Picked =
  | { kind: 'variant'; id: string; label: string }
  | { kind: 'concept'; id: string; label: string }
  | null;

function Suggestions({
  results,
  onPick,
  onCreateNew,
  typedName,
  locale,
  createLabel,
}: {
  results: QuickSearchResult | undefined;
  onPick: (picked: Picked) => void;
  onCreateNew: () => void;
  typedName: string;
  locale: 'en' | 'de' | 'ca';
  createLabel: string;
}) {
  const variants = results?.variants ?? [];
  const concepts = results?.concepts ?? [];

  return (
    <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-surface-2">
      {/* Variants rank above concepts — picking one is the fastest path */}
      {variants.map((variant) => (
        <button
          key={variant.id}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-primary-tint cursor-pointer"
          onClick={() =>
            onPick({ kind: 'variant', id: variant.id, label: resolveText(variant.name, locale) })
          }
        >
          <span className="human-id">{variant.humanId}</span>
          <span className="min-w-0 flex-1 truncate text-text">{resolveText(variant.name, locale)}</span>
          {variant.brand && <span className="text-xs text-muted">{variant.brand}</span>}
        </button>
      ))}
      {concepts.map((concept) => (
        <button
          key={concept.id}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary-tint cursor-pointer"
          onClick={() =>
            onPick({ kind: 'concept', id: concept.id, label: resolveText(concept.name, locale) })
          }
        >
          <span className="human-id">{concept.humanId}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{resolveText(concept.name, locale)}</span>
        </button>
      ))}
      <button
        type="button"
        className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-sm text-primary hover:bg-primary-tint cursor-pointer"
        onClick={onCreateNew}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {createLabel}: <span className="font-medium">{typedName}</span>
      </button>
    </div>
  );
}

export function QuickAddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const typesQuery = useTypes();
  const quickAdd = useQuickAdd();
  const navigate = useNavigate();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Picked>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [typeId, setTypeId] = useState(() => localStorage.getItem(LAST_TYPE_KEY) ?? '');
  const [locationId, setLocationId] = useState<string | null>(
    () => localStorage.getItem(LAST_LOCATION_KEY),
  );
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('');
  const [priceText, setPriceText] = useState('');
  const [copies, setCopies] = useState('1');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const searchQuery = useQuickSearch(picked ? '' : name);
  const type = typesQuery.data?.find((x) => x.id === typeId);

  useEffect(() => {
    if (open) {
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

  // Default to the first type once the list loads and nothing is remembered.
  useEffect(() => {
    if (!typeId && typesQuery.data?.length) setTypeId(typesQuery.data[0]!.id);
  }, [typeId, typesQuery.data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !typeId) return;
    setError(null);
    setSaving(true);
    try {
      const result = await quickAdd.mutateAsync({
        name: name.trim(),
        typeId,
        locationId,
        quantity: quantity ? Number(quantity) : null,
        unit: unit || null,
        priceAmount: priceText ? parseMoneyInput(priceText) : null,
        copies: Number(copies) || 1,
        existingVariantId: picked?.kind === 'variant' ? picked.id : null,
        customFields,
      });

      localStorage.setItem(LAST_TYPE_KEY, typeId);
      if (locationId) localStorage.setItem(LAST_LOCATION_KEY, locationId);

      const ids = result.items.map((i) => i.humanId).join(', ');
      toast({
        message: `✓ ${ids}`,
        variant: 'success',
        // The refine link only makes sense when a brand-new chain was created.
        ...(result.chainCreated
          ? { actionLabel: t('quickAdd.refine'), onAction: () => navigate('/variants') }
          : {}),
      });

      // Batch entry: clear the name, keep everything else, refocus.
      setName('');
      setPicked(null);
      setCustomFields({});
      setShowSuggestions(false);
      nameRef.current?.focus();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('quickAdd.title')}>
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <Label htmlFor="qa-name">{t('quickAdd.name')} *</Label>
          <div className="relative">
            <Input
              id="qa-name"
              ref={nameRef}
              autoComplete="off"
              value={name}
              placeholder={t('quickAdd.namePlaceholder')}
              onChange={(e) => {
                setName(e.target.value);
                setPicked(null);
                setShowSuggestions(true);
              }}
            />
            {picked && (
              <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded bg-primary-tint px-1.5 py-0.5 text-[0.65rem] text-primary">
                <Check className="h-3 w-3" />
                {picked.kind === 'variant' ? t('nav.variants') : t('nav.concepts')}
              </span>
            )}
          </div>
          {showSuggestions && !picked && name.trim().length >= 2 && (
            <Suggestions
              results={searchQuery.data}
              typedName={name.trim()}
              locale={locale}
              createLabel={t('quickAdd.createNew')}
              onPick={(next) => {
                setPicked(next);
                if (next) setName(next.label);
                setShowSuggestions(false);
              }}
              onCreateNew={() => setShowSuggestions(false)}
            />
          )}
        </div>

        {/* A picked variant already knows its type — hide the selector */}
        {picked?.kind !== 'variant' && (
          <div>
            <Label htmlFor="qa-type">{t('nav.types')} *</Label>
            <Select
              id="qa-type"
              value={typeId}
              onChange={(e) => { setTypeId(e.target.value); setCustomFields({}); }}
            >
              {typesQuery.data?.map((x) => (
                <option key={x.id} value={x.id}>{resolveText(x.name, locale)}</option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <Label>{t('items.location')}</Label>
          <LocationPicker value={locationId} onChange={setLocationId} allowClear />
        </div>

        <div className={cn('grid gap-2', 'grid-cols-2 sm:grid-cols-4')}>
          <div>
            <Label htmlFor="qa-qty">{t('items.quantity')}</Label>
            <Input id="qa-qty" type="number" step="any" min="0" value={quantity}
              onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="qa-unit">{t('items.unit')}</Label>
            <Input id="qa-unit" placeholder="L" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="qa-price">{t('items.price')}</Label>
            <Input id="qa-price" placeholder="22.40" value={priceText}
              onChange={(e) => setPriceText(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="qa-copies">{t('items.copies')}</Label>
            <Input id="qa-copies" type="number" min="1" max="100" value={copies}
              onChange={(e) => setCopies(e.target.value)} />
          </div>
        </div>

        {/* Only required custom fields here; the rest live in the full form */}
        {type && type.fieldDefinitions.some((d) => d.required) && (
          <div className="rounded-md border border-line p-3">
            <CustomFields
              definitions={type.fieldDefinitions}
              values={customFields}
              onChange={setCustomFields}
              requiredOnly
            />
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-xs text-muted">{t('quickAdd.staysOpen')}</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
            <Button type="submit" disabled={!name.trim() || !typeId || saving}>
              {t('quickAdd.add')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** Global `q` shortcut — active when no input is focused. */
export function useQuickAddShortcut(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'q' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
