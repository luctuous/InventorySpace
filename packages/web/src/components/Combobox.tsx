import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// A <select> you can type into.
//
// The filter bars used to be plain dropdowns, which are fine with eight
// options and useless with two hundred: finding "Wood glue" meant scrolling a
// native list with no search in it, and the list was capped at one page of
// results anyway. This keeps the shape of a select — one value, a clear
// button, keyboard-operable — and adds the one thing missing, which is typing.
//
// Deliberately not a library. The whole behaviour is a filtered list, a
// highlighted row and four key handlers; a combobox package would be more code
// to read than this file and would bring its own opinions about styling.

export interface ComboOption {
  value: string;
  /** What the person reads and types against. */
  label: string;
  /** Second line — a code, a brand, a pack size. Also searched. */
  hint?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  /** Shown when nothing is selected; also the "any of them" row at the top. */
  placeholder: string;
  /** Omit to make the field required — no "clear" row, no × button. */
  allowClear?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Accent-insensitive, case-insensitive contains.
 *
 * Nobody types the accent when they are in a hurry, and a Catalan workshop is full
 * of them — `Heptà` has to be findable by typing `hepta`. NFD splits the
 * letter from its accent so the accent can be dropped.
 */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  allowClear = true,
  disabled = false,
  id,
  className,
}: Props) {
  const { t } = useI18n();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;

  const matches = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return options;
    return options.filter(
      (option) =>
        normalize(option.label).includes(term) ||
        (option.hint !== undefined && normalize(option.hint).includes(term)),
    );
  }, [options, query]);

  // Clicking anywhere else closes the list and abandons whatever was typed —
  // the selected value is only ever changed by choosing a row.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Wraps, so holding ↓ never dead-ends at the last row.
      setActive((current) => (current + step + matches.length) % Math.max(1, matches.length));
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const chosen = matches[active];
      if (chosen) commit(chosen.value);
      return;
    }
    if (event.key === 'Escape' && open) {
      // Stops the dialog behind it from closing too: the list is what the
      // Escape was aimed at.
      event.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${inputId}-list`}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          // Not a controlled "value = the selection" input: while the list is
          // open the box holds what you are typing, and when it is closed it
          // holds what you picked. Mixing the two is what makes most
          // hand-rolled comboboxes feel broken.
          value={open ? query : (selected?.label ?? '')}
          placeholder={selected ? selected.label : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            'h-9 w-full rounded-md border border-line bg-surface pl-3 text-sm text-text',
            'placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            selected && allowClear ? 'pr-14' : 'pr-8',
          )}
        />
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-2">
          {selected && allowClear && !disabled && (
            <button
              type="button"
              aria-label={t('common.clear')}
              className="pointer-events-auto rounded p-0.5 text-muted hover:text-text cursor-pointer"
              onClick={() => commit('')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
        </div>
      </div>

      {open && (
        <ul
          ref={listRef}
          id={`${inputId}-list`}
          role="listbox"
          className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-xl"
        >
          {allowClear && (
            <li>
              <button
                type="button"
                onClick={() => commit('')}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 cursor-pointer"
              >
                {placeholder}
              </button>
            </li>
          )}
          {matches.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-active={index === active}
                // The mouse takes over the highlight so hovering and arrowing
                // never disagree about which row Enter would pick.
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(option.value)}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm cursor-pointer',
                  index === active ? 'bg-surface-2' : '',
                )}
              >
                <Check
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    option.value === value ? 'text-primary' : 'invisible',
                  )}
                />
                <span className="min-w-0">
                  <span className="block truncate text-text">{option.label}</span>
                  {option.hint && (
                    <span className="block truncate font-mono text-xs text-muted">{option.hint}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">{t('common.noMatches')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
