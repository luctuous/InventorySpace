import { useState } from 'react';
import { Plus, ThumbsUp, X } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { RequestStatus, RequestWithRefs } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import {
  useCancelRequest,
  useRequests,
  useSupportRequest,
} from '../api/operations';
import { RequestModal } from '../components/RequestModal';
import { useToast } from '../components/toast';
import { Button, Pagination, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';

// The Requests screen. This is the buyer's triage inbox and
// the requester's "what happened to my request" view, in one table.

const STATUS_STYLE: Record<RequestStatus, string> = {
  open: 'bg-warning-tint text-warning',
  in_lot: 'bg-secondary-tint text-secondary',
  ordered: 'bg-primary-tint text-primary',
  received: 'bg-success-tint text-success',
  cancelled: 'bg-surface-2 text-muted',
};

function RequestRow({
  request,
  canAct,
  onSupport,
  onCancel,
}: {
  request: RequestWithRefs;
  canAct: boolean;
  onSupport: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { t, locale } = useI18n();

  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          {request.urgency === 'blocking' && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-danger" title={t('requests.blocking')} />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm text-text">
              {resolveText(request.conceptName, locale)}
            </p>
            <p className="font-mono text-xs text-muted">{request.humanId}</p>
          </div>
        </div>
      </td>
      <td className="py-2.5 pr-3 whitespace-nowrap text-sm tabular-nums text-text">
        {request.quantity} {request.unit ?? request.conceptUnit}
      </td>
      <td className="py-2.5 pr-3 whitespace-nowrap text-sm tabular-nums text-muted">
        {request.currentStock} {t('requests.stockNow')}
      </td>
      <td className="py-2.5 pr-3">
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide whitespace-nowrap',
            STATUS_STYLE[request.status],
          )}
        >
          {t(`requests.status.${request.status}`)}
        </span>
        {request.lotHumanId && (
          <span className="ml-1.5 font-mono text-xs text-muted">{request.lotHumanId}</span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-sm text-muted">
        <span className="whitespace-nowrap">{request.requesterName ?? '—'}</span>
        {request.supporters.length > 0 && (
          <span className="ml-1.5 rounded-sm bg-secondary-tint px-1.5 py-0.5 font-mono text-[0.65rem] text-secondary whitespace-nowrap">
            {t('requests.supporters', { n: request.supporters.length })}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 whitespace-nowrap text-xs text-muted">
        {formatDateTime(request.createdAt, locale)}
      </td>
      <td className="py-2.5 text-right">
        {request.status === 'open' && (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              title={t('requests.meToo')}
              onClick={() => onSupport(request.id)}
            >
              <ThumbsUp className="h-4 w-4" />
            </Button>
            {canAct && (
              <Button
                variant="ghost"
                size="icon"
                title={t('requests.cancel')}
                onClick={() => onCancel(request.id)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export function RequestsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('open');
  const [mine, setMine] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const user = session ? asSessionUser(session.user) : null;
  const canAct = user !== null && roleAtLeast(user.role, 'operator');

  const requestsQuery = useRequests({
    page,
    status: status ? [status] : undefined,
    mine,
  });
  const support = useSupportRequest();
  const cancel = useCancelRequest();

  const rows = requestsQuery.data?.data ?? [];
  const meta = requestsQuery.data?.meta;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('requests.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('requests.subtitle')}</p>
        </div>
        {canAct && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('requests.new')}
          </Button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="w-auto"
        >
          <option value="">{t('common.all')}</option>
          <option value="open">{t('requests.status.open')}</option>
          <option value="in_lot">{t('requests.status.in_lot')}</option>
          <option value="ordered">{t('requests.status.ordered')}</option>
          <option value="received">{t('requests.status.received')}</option>
          <option value="cancelled">{t('requests.status.cancelled')}</option>
        </Select>
        <Button
          variant={mine ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => {
            setMine((v) => !v);
            setPage(1);
          }}
        >
          {t('requests.mine')}
        </Button>
      </div>

      {requestsQuery.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-muted">{t('requests.empty')}</p>
      ) : (
        <div
          data-tour="requests-list"
          className="overflow-x-auto rounded-lg border border-line bg-surface"
        >
          <table className="w-full min-w-[46rem]">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">{t('requests.concept')}</th>
                <th className="py-2.5 font-medium">{t('requests.quantity')}</th>
                <th className="py-2.5 font-medium">{t('items.remaining')}</th>
                <th className="py-2.5 font-medium">{t('common.status')}</th>
                <th className="py-2.5 font-medium">{t('history.user')}</th>
                <th className="py-2.5 font-medium">{t('common.created')}</th>
                <th />
              </tr>
            </thead>
            <tbody className="[&>tr>td:first-child]:pl-4 [&>tr>td:last-child]:pr-4">
              {rows.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  canAct={canAct}
                  onSupport={async (id) => {
                    await support.mutateAsync(id);
                    toast({ message: t('requests.joined'), variant: 'success' });
                  }}
                  onCancel={(id) => cancel.mutate(id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {meta && (
        <Pagination page={meta.page} totalPages={meta.totalPages} onPage={setPage} />
      )}

      <RequestModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
