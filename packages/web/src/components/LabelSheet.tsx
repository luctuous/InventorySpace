import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import QRCode from 'qrcode';
import { resolveText } from '@inventory/shared';
import type { ItemWithRefs } from '@inventory/shared';
import { useI18n } from '../i18n';
import { Button, Modal, Spinner } from './ui';

// Printable labels. The QR encodes a deep link to the item, so scanning a
// bottle with any phone camera opens its page in the app — which is the only
// reason a warehouse label is worth printing at all.

export function LabelSheet({
  items,
  onClose,
}: {
  items: ItemWithRefs[];
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [codes, setCodes] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        items.map(async (item) => {
          const url = `${window.location.origin}/items?search=${encodeURIComponent(item.humanId)}`;
          const dataUrl = await QRCode.toDataURL(url, {
            width: 220,
            margin: 0,
            errorCorrectionLevel: 'M',
          });
          return [item.id, dataUrl] as const;
        }),
      );
      if (!cancelled) setCodes(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [items]);

  return (
    <Modal open onClose={onClose} title={t('labels.title')}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {t('labels.intro').replace('{count}', String(items.length))}
        </p>

        {codes === null ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <>
            {/* Screen preview; the print stylesheet takes over on paper. */}
            <div className="label-sheet max-h-72 overflow-y-auto rounded-md border border-line p-3">
              <div className="grid grid-cols-2 gap-2">
                {items.map((item) => (
                  <div key={item.id} className="label flex gap-2 rounded border border-line p-2">
                    <img src={codes[item.id]} alt="" className="h-16 w-16 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-mono text-[0.7rem] font-medium text-text">{item.humanId}</p>
                      <p className="truncate text-[0.65rem] text-muted">
                        {resolveText(item.conceptName, locale) ||
                          resolveText(item.variantName, locale) ||
                          resolveText(item.typeName, locale)}
                      </p>
                      {item.locationCode && (
                        <p className="font-mono text-[0.6rem] text-muted">{item.locationCode}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
              <Button onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> {t('labels.print')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
