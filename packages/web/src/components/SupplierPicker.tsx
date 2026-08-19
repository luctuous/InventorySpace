import { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { useSuppliers } from '../api/operations';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { Input, Label, Spinner } from './ui';

// Suppliers you have used before, most used first, in one click.
// Typing the name again on every order is not just tedious: a typo splits the
// price history of one shop into two, which is the number the whole purchasing
// half exists to produce.

interface Props {
  /** The chosen existing supplier, or null while naming a new one. */
  supplierId: string | null;
  /** A name typed in the "new supplier" box — empty when one was picked. */
  newName: string;
  onPick: (supplierId: string | null) => void;
  onNewName: (name: string) => void;
}

export function SupplierPicker({ supplierId, newName, onPick, onNewName }: Props) {
  const { t } = useI18n();
  const suppliersQuery = useSuppliers();
  const suppliers = suppliersQuery.data ?? [];
  const [adding, setAdding] = useState(false);

  // With nothing on record there is nothing to pick from, so go straight to
  // the text box rather than showing an empty list above it.
  const showList = suppliers.length > 0 && !adding;

  if (suppliersQuery.isLoading) return <Spinner />;

  return (
    <div>
      <Label htmlFor={showList ? undefined : 'supplier-new'}>{t('lots.supplier')}</Label>

      {showList ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {suppliers.map((supplier) => (
              <button
                key={supplier.id}
                type="button"
                onClick={() => {
                  onPick(supplier.id === supplierId ? null : supplier.id);
                  onNewName('');
                }}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors cursor-pointer',
                  supplier.id === supplierId
                    ? 'border-primary bg-primary-tint text-primary'
                    : 'border-line text-text hover:bg-surface-2',
                )}
              >
                {supplier.id === supplierId && <Check className="h-3.5 w-3.5" />}
                {supplier.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              onPick(null);
            }}
            className="mt-2 flex items-center gap-1 text-xs text-muted hover:text-primary cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('lots.newSupplier')}
          </button>
        </>
      ) : (
        <>
          <Input
            id="supplier-new"
            value={newName}
            placeholder={t('lots.supplierPlaceholder')}
            onChange={(e) => {
              onNewName(e.target.value);
              onPick(null);
            }}
            autoFocus={adding}
          />
          {suppliers.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                onNewName('');
              }}
              className="mt-2 text-xs text-muted hover:text-primary cursor-pointer"
            >
              {t('common.cancel')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
