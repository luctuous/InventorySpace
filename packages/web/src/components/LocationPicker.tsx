import { useState } from 'react';
import { MapPin, X } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import { useLocations } from '../api/entities';
import { LocationTree } from './LocationTree';
import { useI18n } from '../i18n';
import { Button, Modal } from './ui';

// Location tree picker used by the item form, the move action and Quick Add.
// Value is a locationId; the button shows the picked node's code + name.

export function LocationPicker({
  value,
  onChange,
  allowClear,
}: {
  value: string | null;
  onChange: (locationId: string | null) => void;
  allowClear?: boolean;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const locationsQuery = useLocations();

  const selected = locationsQuery.data?.find((l) => l.id === value) ?? null;

  return (
    <>
      <div className="flex gap-1.5">
        <Button variant="outline" className="min-w-0 flex-1 justify-start" onClick={() => setOpen(true)}>
          <MapPin className="h-4 w-4 shrink-0 text-muted" />
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="human-id">{selected.code}</span>
              <span className="truncate">{resolveText(selected.name, locale)}</span>
            </span>
          ) : (
            <span className="text-muted">{t('items.pickLocation')}</span>
          )}
        </Button>
        {allowClear && value && (
          <Button variant="ghost" size="icon" onClick={() => onChange(null)}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('items.pickLocation')}>
        <div className="max-h-96 overflow-y-auto">
          <LocationTree
            locations={locationsQuery.data ?? []}
            selectedId={value}
            onSelect={(node) => {
              onChange(node.id);
              setOpen(false);
            }}
          />
        </div>
      </Modal>
    </>
  );
}
