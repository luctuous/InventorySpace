import { resolveText } from '@inventory/shared';
import type { FieldDefinition } from '@inventory/shared';
import { useI18n } from '../i18n';
import { Input, Label, Select } from './ui';

// Renders inputs from a Type's field definitions — the
// "same app, zero code changes" demo moment. Controlled: the parent owns
// the values record; real validation happens server-side against the same
// definitions (buildCustomFieldsValidator).

interface Props {
  definitions: FieldDefinition[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  requiredOnly?: boolean; // Quick Add shows required fields only
}

export function CustomFields({ definitions, values, onChange, requiredOnly }: Props) {
  const { locale } = useI18n();
  const defs = [...definitions]
    .filter((def) => !requiredOnly || def.required)
    .sort((a, b) => a.order - b.order);

  if (defs.length === 0) return null;

  const set = (key: string, value: unknown) =>
    onChange({ ...values, [key]: value === '' ? null : value });

  return (
    <div className="space-y-3">
      {defs.map((def) => {
        const label = (
          <Label htmlFor={`cf-${def.key}`}>
            {resolveText(def.label, locale)}
            {def.required && <span className="text-danger"> *</span>}
            {def.kind === 'number' && def.unit && (
              <span className="text-muted"> ({def.unit})</span>
            )}
          </Label>
        );
        const value = values[def.key];

        switch (def.kind) {
          case 'boolean':
            return (
              <label key={def.key} className="flex cursor-pointer items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-(--color-primary-base)"
                  checked={Boolean(value)}
                  onChange={(e) => set(def.key, e.target.checked)}
                />
                {resolveText(def.label, locale)}
                {def.required && <span className="text-danger">*</span>}
              </label>
            );
          case 'select':
            return (
              <div key={def.key}>
                {label}
                <Select
                  id={`cf-${def.key}`}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(def.key, e.target.value)}
                >
                  <option value="">—</option>
                  {(def.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>
            );
          case 'number':
            return (
              <div key={def.key}>
                {label}
                <Input
                  id={`cf-${def.key}`}
                  type="number"
                  step="any"
                  value={typeof value === 'number' ? value : ''}
                  onChange={(e) =>
                    set(def.key, e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </div>
            );
          case 'date':
            return (
              <div key={def.key}>
                {label}
                <Input
                  id={`cf-${def.key}`}
                  type="date"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(def.key, e.target.value)}
                />
              </div>
            );
          default:
            return (
              <div key={def.key}>
                {label}
                <Input
                  id={`cf-${def.key}`}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(def.key, e.target.value)}
                />
              </div>
            );
        }
      })}
    </div>
  );
}
