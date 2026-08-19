import { useState } from 'react';
import { CalendarClock, Check, Link2, Paperclip, Plus, Repeat, Trash2, X } from 'lucide-react';
import { ITEM_RELATIONS, MAINTENANCE_KINDS, resolveText, roleAtLeast } from '@inventory/shared';
import type {
  ItemLinkWithRefs,
  ItemRelation,
  ItemWithRefs,
  MaintenanceKind,
  MaintenancePlanWithStatus,
} from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useItems } from '../api/entities';
import {
  useCountUses,
  useCreateItemLink,
  useCreateMaintenancePlan,
  useDeleteItemLink,
  useDeleteMaintenancePlan,
  useItemLinks,
  useMaintenanceDone,
  useMaintenancePlans,
  useMaintenanceRecords,
} from '../api/operations';
import { useToast } from './toast';
import { Button, Input, Label, Modal, Select, Spinner, StatusBadge } from './ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';

// Equipment tab of the item drawer. Two things a machine has
// that a bottle of buffer does not: other items hanging off it, and a service
// schedule. Both are generic — a cupboard has an interval, a torque wrench has a
// certificate — so nothing here is gated behind a type called "instrument".

/** Overdue reads as an alarm, due-soon as a warning, everything else as calm. */
function statusTone(plan: MaintenancePlanWithStatus): string {
  if (plan.overdue) return 'border-danger/40 bg-danger-tint';
  if (plan.dueSoon) return 'border-warning/40 bg-warning-tint';
  return 'border-line';
}

/**
 * "Overdue by 35 days" beats "-35". Both counters can be live at once, and
 * then both are worth saying: a plan is late as soon as either runs out.
 */
export function useDueLabel() {
  const { t } = useI18n();
  return (plan: MaintenancePlanWithStatus): string => {
    const parts: string[] = [];
    if (plan.daysUntilDue !== null) {
      const days = Math.round(plan.daysUntilDue);
      // "Overdue by 0 days" is nonsense; the day it lands, it is due now.
      parts.push(
        days === 0
          ? t('equipment.dueNow')
          : days < 0
            ? t('equipment.overdueDays', { n: -days })
            : t('equipment.inDays', { n: days }),
      );
    }
    if (plan.usesUntilDue !== null) {
      const uses = plan.usesUntilDue;
      parts.push(
        uses === 0
          ? t('equipment.dueNow')
          : uses < 0
            ? t('equipment.overdueUses', { n: -uses })
            : t('equipment.inUses', { n: uses }),
      );
    }
    // Both counters at zero would say "due now · due now".
    return [...new Set(parts)].join(' · ');
  };
}

// ------------------------------------------------------------------- links

function LinkRow({
  link,
  canOperate,
  onDetach,
}: {
  link: ItemLinkWithRefs;
  canOperate: boolean;
  onDetach: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="flex items-center gap-2 border-b border-line py-2 last:border-0">
      <span className="w-20 shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-center text-[0.65rem] uppercase tracking-wide text-muted">
        {t(`equipment.relation.${link.relation}`)}
      </span>
      <span className="human-id shrink-0">{link.otherHumanId}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-text">
        {resolveText(link.otherName, locale) || '—'}
        {link.notes && <span className="ml-2 text-xs text-muted">{link.notes}</span>}
      </span>
      {link.otherLocationCode && (
        <span className="human-id shrink-0 text-xs">{link.otherLocationCode}</span>
      )}
      <StatusBadge status={link.otherStatus as never} />
      {canOperate && link.direction === 'child' && (
        <Button variant="ghost" size="icon" onClick={onDetach} title={t('equipment.detach')}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function AttachModal({
  open,
  onClose,
  itemId,
  excludeIds,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  excludeIds: string[];
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [relation, setRelation] = useState<ItemRelation>('document');
  const [notes, setNotes] = useState('');
  const createLink = useCreateItemLink();

  // Only search once there is something to search for: an unfiltered list of
  // every item in the workshop is not a picker, it is a wall.
  const results = useItems({ search, perPage: 20 }, { enabled: search.trim().length >= 2 });
  const candidates = (results.data?.data ?? []).filter(
    (candidate) => candidate.id !== itemId && !excludeIds.includes(candidate.id),
  );

  const attach = async (childItemId: string, humanId: string) => {
    try {
      await createLink.mutateAsync({
        itemId,
        body: { childItemId, relation, notes: notes.trim() || null },
      });
      toast({ message: `${humanId} · ${t('equipment.attachedDone')}`, variant: 'success' });
      setSearch('');
      setNotes('');
      onClose();
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('equipment.attach')}>
      <div className="space-y-3">
        <div>
          <Label>{t('equipment.relationLabel')}</Label>
          <Select value={relation} onChange={(e) => setRelation(e.target.value as ItemRelation)}>
            {ITEM_RELATIONS.map((value) => (
              <option key={value} value={value}>
                {t(`equipment.relation.${value}`)}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label>{t('equipment.searchItem')}</Label>
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('equipment.searchPlaceholder')}
          />
        </div>

        <div>
          <Label>{t('equipment.linkNotes')}</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('equipment.linkNotesPlaceholder')}
          />
        </div>

        <div className="max-h-64 overflow-y-auto rounded-md border border-line">
          {search.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {t('equipment.searchHint')}
            </p>
          ) : results.isPending ? (
            <div className="py-6 text-center">
              <Spinner />
            </div>
          ) : candidates.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{t('common.empty')}</p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => void attach(candidate.id, candidate.humanId)}
                className="flex w-full cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-left last:border-0 hover:bg-surface-2"
              >
                <span className="human-id shrink-0">{candidate.humanId}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {resolveText(candidate.variantName, locale) ||
                    resolveText(candidate.conceptName, locale) ||
                    '—'}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {resolveText(candidate.typeName, locale)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- maintenance

function PlanCard({
  plan,
  canOperate,
  canManage,
}: {
  plan: MaintenancePlanWithStatus;
  canOperate: boolean;
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const dueLabel = useDueLabel();
  const [showRecords, setShowRecords] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneNotes, setDoneNotes] = useState('');
  const markDone = useMaintenanceDone();
  const deletePlan = useDeleteMaintenancePlan();
  const records = useMaintenanceRecords(showRecords ? plan.id : null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast({ message: label, variant: 'success' });
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  const interval = [
    plan.everyDays !== null ? t('equipment.everyNDays', { n: plan.everyDays }) : null,
    plan.everyUses !== null ? t('equipment.everyNUses', { n: plan.everyUses }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={cn('rounded-md border px-3 py-2.5', statusTone(plan))}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text">
              {resolveText(plan.name, locale)}
            </span>
            <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted">
              {t(`equipment.kind.${plan.kind}`)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {interval}
            {plan.everyUses !== null && (
              <span className="ml-2 font-mono">
                {t('equipment.usesSinceLast', { n: plan.usesSinceLast })}
              </span>
            )}
          </p>
          <p
            className={cn(
              'mt-1 text-xs font-medium',
              plan.overdue ? 'text-danger' : plan.dueSoon ? 'text-warning' : 'text-muted',
            )}
          >
            {dueLabel(plan)}
            {plan.lastDoneAt && (
              <span className="ml-2 font-normal text-muted">
                {t('equipment.lastDone')} {formatDateTime(plan.lastDoneAt, locale)}
              </span>
            )}
          </p>
          {plan.notes && <p className="mt-1 text-xs text-muted">{plan.notes}</p>}
        </div>

        {canManage && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.delete')}
            onClick={() => {
              if (!window.confirm(t('equipment.deletePlanConfirm'))) return;
              void run(t('common.deleted'), () => deletePlan.mutateAsync(plan.id));
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canOperate && (
          <Button size="sm" onClick={() => setDoneOpen(true)}>
            <Check className="h-4 w-4" /> {t('equipment.markDone')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowRecords((v) => !v)}>
          {showRecords ? t('equipment.hideRecords') : t('equipment.showRecords')}
        </Button>
      </div>

      {showRecords && (
        <div className="mt-2 border-t border-line pt-2">
          {records.isPending ? (
            <div className="py-3 text-center">
              <Spinner />
            </div>
          ) : records.data?.length === 0 ? (
            <p className="py-2 text-xs text-muted">{t('equipment.noRecords')}</p>
          ) : (
            records.data?.map((record) => (
              <div key={record.id} className="py-1 text-xs">
                <span className="font-mono text-muted">
                  {formatDateTime(record.doneAt, locale)}
                </span>
                <span className="ml-2 text-text">{record.userName ?? '—'}</span>
                {record.usesAtService !== null && (
                  <span className="ml-2 font-mono text-muted">
                    {t('equipment.atUses', { n: record.usesAtService })}
                  </span>
                )}
                {record.notes && <span className="ml-2 text-muted">{record.notes}</span>}
              </div>
            ))
          )}
        </div>
      )}

      <Modal
        open={doneOpen}
        onClose={() => setDoneOpen(false)}
        title={resolveText(plan.name, locale)}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('equipment.doneHelp')}</p>
          <div>
            <Label>{t('equipment.doneNotes')}</Label>
            <Input
              autoFocus
              value={doneNotes}
              onChange={(e) => setDoneNotes(e.target.value)}
              placeholder={t('equipment.doneNotesPlaceholder')}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDoneOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void run(t('equipment.doneToast'), async () => {
                  await markDone.mutateAsync({
                    planId: plan.id,
                    body: { notes: doneNotes.trim() || null },
                  });
                  setDoneNotes('');
                  setDoneOpen(false);
                });
              }}
            >
              <Check className="h-4 w-4" /> {t('equipment.markDone')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PlanModal({
  open,
  onClose,
  itemId,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const createPlan = useCreateMaintenancePlan();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MaintenanceKind>('service');
  const [everyDays, setEveryDays] = useState('');
  const [everyUses, setEveryUses] = useState('');
  const [lastDone, setLastDone] = useState('');

  const submit = async () => {
    const days = everyDays.trim() ? Number(everyDays) : null;
    const uses = everyUses.trim() ? Number(everyUses) : null;
    if (!name.trim()) return;
    if (days === null && uses === null) {
      toast({ message: t('equipment.needInterval'), variant: 'danger' });
      return;
    }
    try {
      await createPlan.mutateAsync({
        itemId,
        body: {
          name: { en: name.trim() },
          kind,
          everyDays: days,
          everyUses: uses,
          lastDoneAt: lastDone ? new Date(lastDone).toISOString() : null,
        },
      });
      toast({ message: t('equipment.planCreated'), variant: 'success' });
      setName('');
      setEveryDays('');
      setEveryUses('');
      setLastDone('');
      onClose();
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('equipment.addPlan')}>
      <div className="space-y-3">
        <div>
          <Label>{t('equipment.planName')}</Label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('equipment.planNamePlaceholder')}
          />
        </div>
        <div>
          <Label>{t('equipment.kindLabel')}</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as MaintenanceKind)}>
            {MAINTENANCE_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`equipment.kind.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('equipment.everyDays')}</Label>
            <Input
              type="number"
              min={1}
              value={everyDays}
              onChange={(e) => setEveryDays(e.target.value)}
              placeholder="365"
            />
          </div>
          <div>
            <Label>{t('equipment.everyUses')}</Label>
            <Input
              type="number"
              min={1}
              value={everyUses}
              onChange={(e) => setEveryUses(e.target.value)}
              placeholder="500"
            />
          </div>
        </div>
        {/* Without this the clock starts today, which quietly hides a machine
            that has already been out of calibration for a year. */}
        <div>
          <Label>{t('equipment.lastDoneLabel')}</Label>
          <Input type="date" value={lastDone} onChange={(e) => setLastDone(e.target.value)} />
        </div>
        <p className="text-xs text-muted">{t('equipment.intervalHelp')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------- the panel

export function EquipmentPanel({ item }: { item: ItemWithRefs }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const links = useItemLinks(item.id);
  const plans = useMaintenancePlans(item.id);
  const detach = useDeleteItemLink();
  const countUses = useCountUses();
  const [attachOpen, setAttachOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  const user = session ? asSessionUser(session.user) : null;
  const canOperate = user !== null && roleAtLeast(user.role, 'operator');
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const children = links.data?.children ?? [];
  const parents = links.data?.parents ?? [];
  const countsUses = (plans.data ?? []).some((plan) => plan.everyUses !== null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast({ message: label, variant: 'success' });
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------ attached */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            <Paperclip className="h-3.5 w-3.5" /> {t('equipment.attached')}
          </h3>
          {canOperate && (
            <Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>
              <Plus className="h-4 w-4" /> {t('equipment.attach')}
            </Button>
          )}
        </div>

        {links.isPending ? (
          <div className="py-4 text-center">
            <Spinner />
          </div>
        ) : children.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
            {t('equipment.attachedEmpty')}
          </p>
        ) : (
          <div>
            {children.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                canOperate={canOperate}
                onDetach={() => {
                  void run(t('equipment.detached'), () => detach.mutateAsync(link.id));
                }}
              />
            ))}
          </div>
        )}

        {parents.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
              <Link2 className="h-3.5 w-3.5" /> {t('equipment.partOf')}
            </h3>
            {parents.map((link) => (
              <LinkRow key={link.id} link={link} canOperate={false} onDetach={() => {}} />
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------------------------- maintenance */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            <CalendarClock className="h-3.5 w-3.5" /> {t('equipment.maintenance')}
          </h3>
          <div className="flex gap-2">
            {canOperate && countsUses && (
              <Button
                size="sm"
                variant="outline"
                title={t('equipment.countUseHelp')}
                onClick={() => {
                  void run(t('equipment.useCounted'), () =>
                    countUses.mutateAsync({ itemId: item.id, uses: 1 }),
                  );
                }}
              >
                <Repeat className="h-4 w-4" /> {t('equipment.countUse')}
              </Button>
            )}
            {canOperate && (
              <Button size="sm" variant="outline" onClick={() => setPlanOpen(true)}>
                <Plus className="h-4 w-4" /> {t('equipment.addPlan')}
              </Button>
            )}
          </div>
        </div>

        {plans.isPending ? (
          <div className="py-4 text-center">
            <Spinner />
          </div>
        ) : (plans.data ?? []).length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
            {t('equipment.maintenanceEmpty')}
          </p>
        ) : (
          <div className="space-y-2">
            {plans.data?.map((plan) => (
              <PlanCard key={plan.id} plan={plan} canOperate={canOperate} canManage={canManage} />
            ))}
          </div>
        )}
      </section>

      <AttachModal
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        itemId={item.id}
        excludeIds={children.map((link) => link.otherItemId)}
      />
      <PlanModal open={planOpen} onClose={() => setPlanOpen(false)} itemId={item.id} />
    </div>
  );
}
