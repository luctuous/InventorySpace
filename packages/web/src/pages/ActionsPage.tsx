import { useEffect, useState } from 'react';
import { History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { ActionWithCost } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConcepts } from '../api/concepts';
import { useItemAction } from '../api/entities';
import {
  useActionVersions,
  useActions,
  useCreateAction,
  useDeleteAction,
  useReconciliations,
  useRecordAction,
  useUnassignedSummary,
  useUpdateAction,
} from '../api/operations';
import { useToast } from '../components/toast';
import {
  Button,
  Drawer,
  FieldError,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
} from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDate, formatDateTime, formatPrice } from '../lib/format';

// Level 3. Two costs sit side by side on every card:
// theoretical (map × price) and real (plus this action's share of unassigned
// consumption). Their ratio is a process-quality metric.

interface MapLine {
  conceptId: string;
  quantity: string;
}

function ActionForm({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: ActionWithCost | null;
}) {
  const { t, locale } = useI18n();
  const conceptsQuery = useConcepts({ page: 1, perPage: 100 });
  const createAction = useCreateAction();
  const updateAction = useUpdateAction();

  const [name, setName] = useState('');
  const [lines, setLines] = useState<MapLine[]>([{ conceptId: '', quantity: '1' }]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing ? resolveText(editing.name, locale) : '');
    setLines(
      editing && editing.lines.length > 0
        ? editing.lines.map((line) => ({
            conceptId: line.conceptId,
            quantity: String(line.quantity),
          }))
        : [{ conceptId: '', quantity: '1' }],
    );
  }, [open, editing, locale]);

  const concepts = conceptsQuery.data?.data ?? [];

  const submit = async () => {
    setError(null);
    const parsed = lines
      .filter((line) => line.conceptId)
      .map((line) => ({ conceptId: line.conceptId, quantity: Number(line.quantity) }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (!name.trim() || parsed.length === 0) {
      setError(t('actions.map'));
      return;
    }
    try {
      if (editing) {
        await updateAction.mutateAsync({
          id: editing.id,
          body: { name: { en: name.trim() }, lines: parsed },
        });
      } else {
        await createAction.mutateAsync({ name: { en: name.trim() }, lines: parsed });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('common.edit') : t('actions.new')}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="act-name">{t('common.name')}</Label>
          <Input id="act-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <Label>{t('actions.map')}</Label>
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="flex gap-2">
                <Select
                  value={line.conceptId}
                  onChange={(e) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index ? { ...l, conceptId: e.target.value } : l,
                      ),
                    )
                  }
                >
                  <option value="">—</option>
                  {concepts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {resolveText(c.name, locale)} ({c.unit})
                    </option>
                  ))}
                </Select>
                <Input
                  className="w-24"
                  type="number"
                  step="any"
                  min="0"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index ? { ...l, quantity: e.target.value } : l,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setLines((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => setLines((current) => [...current, { conceptId: '', quantity: '1' }])}
          >
            <Plus className="h-4 w-4" />
            {t('actions.addLine')}
          </Button>
        </div>

        {editing && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            {t('actions.newVersionHint')}
          </p>
        )}

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={createAction.isPending || updateAction.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RecordModal({
  open,
  onClose,
  action,
}: {
  open: boolean;
  onClose: () => void;
  action: ActionWithCost;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const record = useRecordAction();
  const itemAction = useItemAction();
  const [count, setCount] = useState('1');
  const [result, setResult] = useState<Awaited<ReturnType<typeof record.mutateAsync>> | null>(null);

  useEffect(() => {
    if (open) {
      setCount('1');
      setResult(null);
    }
  }, [open]);

  const submit = async () => {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return;
    const outcome = await record.mutateAsync({ actionId: action.id, count: n });
    setResult(outcome);

    // Recording must be near-zero friction, so get out of the way when there
    // is nothing to decide. But "the estimate had nowhere to land" must never
    // vanish silently — an unbacked concept means the map is charging against
    // a container that does not exist, and the user has to see that.
    const needsAttention =
      outcome.prompts.length > 0 || outcome.charged.some((charge) => charge.unbacked);
    if (!needsAttention) {
      toast({ message: t('actions.record'), variant: 'success' });
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('actions.recordTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-text">{resolveText(action.name, locale)}</p>

        {!result && (
          <>
            <div>
              <Label htmlFor="rec-count">{t('actions.howMany')}</Label>
              <Input
                id="rec-count"
                type="number"
                min="1"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={submit} disabled={record.isPending}>
                {t('actions.record')}
              </Button>
            </div>
          </>
        )}

        {result && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-muted">
                {t('actions.charged')}
              </p>
              <ul className="space-y-1">
                {result.charged.map((charge, index) => (
                  <li key={index} className="flex justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-text">
                      {resolveText(charge.conceptName, locale)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {charge.quantity}
                      {charge.unbacked ? ` · ${t('actions.unbacked')}` : ` → ${charge.itemHumanId}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* The activity moved the quantity; closing the container is a
                person's decision, always. Neither answer asks for a
                number: if there is more left than the recipe expected, that
                truth gets recorded when the container is finally closed. */}
            {result.prompts.map((prompt) => (
              <div
                key={prompt.itemId}
                className="rounded-lg border border-warning/50 bg-warning-tint p-3"
              >
                <p className="text-sm text-text">
                  {t('actions.prompt', { item: prompt.itemHumanId })}
                </p>
                <p className="font-mono text-xs text-muted">
                  {prompt.estimatedUsed} / {prompt.containerQuantity}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      await itemAction.mutateAsync({ id: prompt.itemId, action: 'deplete' });
                      toast({ message: t('items.depleted'), variant: 'success' });
                      onClose();
                    }}
                  >
                    {t('actions.markDepleted')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onClose}>
                    {t('actions.notYet')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function VersionsDrawer({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const versionsQuery = useActionVersions(actionId);

  return (
    <Drawer open onClose={onClose} title={t('actions.versions')}>
      <p className="mb-3 text-sm text-muted">{t('actions.newVersionHint')}</p>
      <div className="space-y-3">
        {(versionsQuery.data ?? []).map((version, index) => (
          <div key={index} className="rounded-lg border border-line p-3">
            <p className="text-xs uppercase tracking-wide text-muted">
              {t('actions.validFrom')} {formatDate(version.validFrom, locale)}
              {version.validTo === null && ` · ${t('actions.current')}`}
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {version.lines.map((line, i) => (
                <li key={i} className="flex justify-between text-sm">
                  <span className="text-text">{resolveText(line.conceptName, locale)}</span>
                  <span className="tabular-nums text-muted">{line.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Drawer>
  );
}

function UnassignedPanel() {
  const { t, locale } = useI18n();
  const summaryQuery = useUnassignedSummary();
  const reconciliationsQuery = useReconciliations();
  const rows = summaryQuery.data ?? [];
  const closed = reconciliationsQuery.data ?? [];

  if (rows.length === 0) return null;

  return (
    <div className="mb-5 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-text">{t('actions.unassigned')}</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">{t('actions.unassignedHint')}</p>

      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.conceptId} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-sm text-text">
              {resolveText(row.conceptName, locale)}
            </span>
            <span className="font-mono text-xs text-muted">
              {t('actions.held')} {row.totalHeld} · {t('actions.claimed')} {row.totalTheoretical} ·{' '}
              <span className="text-accent">
                {t('actions.gap')} {row.totalUnassigned}
              </span>
              {/* The gap as a RATE, over the days a container stood open.
                  Splitting it across the activities in the window would claim
                  to know it was the activities; this does not. */}
              {row.unassignedPerDay !== null && (
                <span className="text-accent">
                  {' · '}
                  {t('actions.perDay', { n: row.unassignedPerDay, days: row.daysOpen ?? 0 })}
                </span>
              )}
              {row.ratio !== null && ` · ${row.ratio}×`}
            </span>
          </div>
        ))}
      </div>

      {closed.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">
            {t('actions.reconciliations')} ({closed.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {closed.slice(0, 10).map((row) => (
              <li key={row.id} className="font-mono text-xs text-muted">
                {row.itemHumanId} · {formatDateTime(row.closedAt, locale)} ·{' '}
                {row.containerQuantity} / {row.theoreticalUsed} → {row.unassigned}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ActionsPage() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ActionWithCost | null>(null);
  const [recording, setRecording] = useState<ActionWithCost | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');
  const canRecord = user !== null && roleAtLeast(user.role, 'operator');

  const actionsQuery = useActions();
  const deleteAction = useDeleteAction();
  const actions = actionsQuery.data ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('actions.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('actions.subtitle')}</p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('actions.new')}
          </Button>
        )}
      </div>

      <UnassignedPanel />

      {actionsQuery.isLoading ? (
        <Spinner />
      ) : actions.length === 0 ? (
        <p className="text-muted">{t('actions.empty')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {actions.map((action) => (
            <div key={action.id} className="min-w-0 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">
                    {resolveText(action.name, locale)}
                  </p>
                  <p className="font-mono text-xs text-muted">
                    {action.humanId} · {action.recordCount} ×
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t('actions.versions')}
                    onClick={() => setVersionsFor(action.id)}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setEditing(action);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteAction.mutate(action.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <ul className="mt-2 space-y-0.5">
                {action.lineDetails.map((line) => (
                  <li key={line.conceptId} className="flex justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-muted">
                      {resolveText(line.conceptName, locale)}
                    </span>
                    <span className="shrink-0 tabular-nums text-text">
                      {line.quantity} {line.conceptUnit}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Theoretical and real, always together. */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-md bg-surface-2 px-2.5 py-1.5">
                  <p className="text-[0.65rem] uppercase tracking-wide text-muted">
                    {t('actions.theoreticalCost')}
                  </p>
                  <p className="tabular-nums text-sm text-text">
                    {formatPrice(action.theoreticalCost, action.currency, locale)}
                  </p>
                </div>
                <div
                  className={cn(
                    'rounded-md px-2.5 py-1.5',
                    action.costRatio !== null && action.costRatio > 1.1
                      ? 'bg-accent-tint'
                      : 'bg-surface-2',
                  )}
                >
                  <p className="text-[0.65rem] uppercase tracking-wide text-muted">
                    {t('actions.realCost')}
                  </p>
                  <p className="tabular-nums text-sm text-text">
                    {formatPrice(action.realCost, action.currency, locale)}
                  </p>
                </div>
              </div>
              {action.costRatio !== null && action.costRatio !== 1 && (
                <p className="mt-1 text-xs text-accent">
                  {t('actions.costRatio', { ratio: action.costRatio })}
                </p>
              )}

              {canRecord && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => setRecording(action)}
                >
                  <Play className="h-4 w-4" />
                  {t('actions.record')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <ActionForm open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      {recording && (
        <RecordModal open onClose={() => setRecording(null)} action={recording} />
      )}
      {versionsFor && (
        <VersionsDrawer actionId={versionsFor} onClose={() => setVersionsFor(null)} />
      )}
    </div>
  );
}
