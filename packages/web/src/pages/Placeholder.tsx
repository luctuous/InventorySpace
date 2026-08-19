import { useI18n } from '../i18n';

// Temporary stand-in while pages are built phase by phase.
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useI18n();
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold text-text">{t(titleKey)}</h1>
      <p className="text-sm text-muted">{t('common.comingSoon')}</p>
    </div>
  );
}
