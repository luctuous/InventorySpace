import { useState } from 'react';
import { LOCALES } from '@inventory/shared';
import type { Locale } from '@inventory/shared';
import type { UseFormRegister, FieldValues, Path } from 'react-hook-form';
import { cn } from '../lib/cn';
import { Input, Label } from './ui';

// Tabbed per-language name input: EN required, DE/CA optional.
// Registers `<basePath>.en|de|ca` on the given react-hook-form instance.

interface Props<T extends FieldValues> {
  label: string;
  basePath: string; // e.g. "name" or "label"
  register: UseFormRegister<T>;
  error?: string;
  placeholder?: string;
}

export function MultilangInput<T extends FieldValues>({
  label,
  basePath,
  register,
  error,
  placeholder,
}: Props<T>) {
  const [tab, setTab] = useState<Locale>('en');

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="mb-0">{label}</Label>
        <div className="flex gap-1">
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setTab(code)}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[0.65rem] uppercase cursor-pointer',
                tab === code
                  ? 'bg-primary-tint font-semibold text-primary'
                  : 'text-muted hover:text-text',
              )}
            >
              {code}
              {code === 'en' ? '*' : ''}
            </button>
          ))}
        </div>
      </div>
      {LOCALES.map((code) => (
        <Input
          key={code}
          className={tab === code ? '' : 'hidden'}
          placeholder={code === 'en' ? placeholder : ''}
          {...register(`${basePath}.${code}` as Path<T>)}
        />
      ))}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
