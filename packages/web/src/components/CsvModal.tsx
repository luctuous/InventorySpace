import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import type { CsvImportResult } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useImportItems } from '../api/entities';
import { useToast } from './toast';
import { Button, Modal, Spinner } from './ui';
import { useI18n } from '../i18n';

// Import is two-phase on purpose: a dry run reports what would happen and what
// would fail, and only then do you commit. The real import is one transaction,
// so a spreadsheet with one bad row imports nothing rather than half of itself.

export function CsvImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const importItems = useImportItems();
  const fileRef = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<CsvImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCsv(''); setFileName(''); setPreview(null); setError(null);
  };

  const pickFile = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setPreview(null);
    setError(null);
    try {
      setPreview(await importItems.mutateAsync({ csv: text, dryRun: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  const commit = async () => {
    setError(null);
    try {
      const result = await importItems.mutateAsync({ csv, dryRun: false });
      toast({
        message: t('csv.imported').replace('{count}', String(result.created)),
        variant: 'success',
      });
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const details = err.details as { errors?: Array<{ row: number; message: string }> };
        setError(
          details?.errors
            ? details.errors.map((e) => `${t('csv.row')} ${e.row}: ${e.message}`).join('\n')
            : err.message,
        );
      } else {
        setError(String(err));
      }
    }
  };

  const blocked = (preview?.errors.length ?? 0) > 0;

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title={t('csv.importTitle')}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('csv.importIntro')}</p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickFile(file);
          }}
        />
        <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
          <FileUp className="h-4 w-4" />
          {fileName || t('csv.chooseFile')}
        </Button>

        {importItems.isPending && !preview && (
          <div className="flex justify-center py-4"><Spinner /></div>
        )}

        {preview && (
          <div className="rounded-md border border-line p-3 text-sm">
            <p className="text-text">
              {t('csv.previewRows').replace('{rows}', String(preview.rows))}
            </p>
            {blocked ? (
              <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs text-danger">
                {preview.errors.map((rowError) => (
                  <li key={rowError.row}>
                    {t('csv.row')} {rowError.row}: {rowError.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-success">{t('csv.previewOk')}</p>
            )}
          </div>
        )}

        {error && <pre className="whitespace-pre-wrap text-xs text-danger">{error}</pre>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!preview || blocked || importItems.isPending}
            onClick={() => void commit()}
          >
            {t('csv.import')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
