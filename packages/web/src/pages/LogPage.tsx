import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import type { LogEffect, LogEventDef, LogField, LogLineStatus } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useConcepts } from '../api/concepts';
import {
  useActions,
  useCreateLogEvent,
  useCreateLogSource,
  useDeleteLogEvent,
  useIngest,
  useLogEvents,
  useLogHealth,
  useLogLines,
  useLogSources,
  usePools,
  useProbeParser,
  useUnknownEvents,
  useUpdateLogEvent,
  useUpdateLogSource,
} from '../api/operations';
import { useToast } from '../components/toast';
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';

// The log bridge. Two things of very different natures live
// on this page: the line shape, configured once, and the event dictionary,
// which is the living configuration.

const LOG_FIELDS: LogField[] = ['time', 'type', 'id', 'event', 'skip'];

const STATUS_STYLE: Record<LogLineStatus, string> = {
  applied: 'bg-success-tint text-success',
  shadow: 'bg-secondary-tint text-secondary',
  unknown_event: 'bg-warning-tint text-warning',
  unknown_object: 'bg-warning-tint text-warning',
  error: 'bg-danger-tint text-danger',
};

// ---------------------------------------------------------------- source form

/**
 * The paste-and-highlight parser builder. This is the single most important
 * usability decision in the feature: nobody ever writes a regular expression.
 */
function SourceForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const probe = useProbeParser();
  const createSource = useCreateLogSource();

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [sample, setSample] = useState('');
  const [assignments, setAssignments] = useState<LogField[]>([]);
  const [error, setError] = useState<string | null>(null);

  // You label the parts of ONE line. Extra lines pasted below it are only
  // there to preview the derived pattern against, so they must not be
  // labelled — otherwise the labels and the sample stop lining up.
  const firstLine = sample.split('\n').find((line) => line.trim()) ?? '';
  const tokens = firstLine.trim() ? firstLine.trim().split(/\s+/) : [];

  useEffect(() => {
    if (!open) return;
    setName('');
    setPath('');
    setSample('');
    setAssignments([]);
    setError(null);
  }, [open]);

  // Guess sensibly the first time a line is pasted: time, object, event.
  useEffect(() => {
    setAssignments((current) => {
      if (current.length === tokens.length) return current;
      return tokens.map((token, index) => {
        if (/^\d{1,2}:\d{2}/.test(token)) return 'time';
        if (index === tokens.length - 1) return 'event';
        if (token.includes('_')) return 'id';
        return index === 0 ? 'time' : 'id';
      });
    });
  }, [sample, tokens.length]);

  const result = probe.data;

  return (
    <Modal open={open} onClose={onClose} title={t('log.newSource')}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="src-name">{t('log.sourceName')}</Label>
            <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="src-path">{t('log.path')}</Label>
            <Input
              id="src-path"
              placeholder="/var/log/lims/events.log"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="src-sample">{t('log.sample')}</Label>
          <Textarea
            id="src-sample"
            rows={2}
            className="font-mono text-xs"
            placeholder="12:40:32  Mostra_DMK3-21099-2621703602  RegistreMostraK"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">{t('log.sampleHint')}</p>
        </div>

        {tokens.length > 0 && (
          <div className="space-y-1.5">
            {tokens.map((token, index) => (
              <div key={index} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-xs text-text">
                  {token}
                </code>
                <Select
                  className="w-36 shrink-0"
                  value={assignments[index] ?? 'skip'}
                  onChange={(e) =>
                    setAssignments((current) =>
                      current.map((a, i) => (i === index ? (e.target.value as LogField) : a)),
                    )
                  }
                >
                  {LOG_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {t(`log.field.${field}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => probe.mutate({ sample: firstLine, assignments, content: sample })}
              disabled={probe.isPending}
            >
              <Eye className="h-4 w-4" />
              {t('log.preview')}
            </Button>
          </div>
        )}

        {result && (
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <p className="mb-2 text-xs text-muted">
              {t('log.matches', { matched: result.matchedCount, total: result.totalCount })}
            </p>
            <ul className="space-y-1">
              {result.preview.map((line, index) => (
                <li key={index} className="font-mono text-xs">
                  {line.matched ? (
                    <span className="text-text">
                      <span className="text-muted">{line.time ?? '—'}</span>{' '}
                      <span className="text-secondary">{line.type ?? '—'}</span>{' '}
                      <span className="text-text">{line.id ?? '—'}</span>{' '}
                      <span className="text-primary">{line.event ?? '—'}</span>
                    </span>
                  ) : (
                    <span className="text-danger">{line.raw}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              if (!result || !name.trim() || !path.trim()) {
                setError(t('log.preview'));
                return;
              }
              try {
                await createSource.mutateAsync({
                  name: name.trim(),
                  path: path.trim(),
                  parser: result.parser,
                  enabled: false,
                  silenceMinutes: 240,
                });
                onClose();
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.message : String(err));
              }
            }}
            disabled={createSource.isPending || !result}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- event form

function EffectEditor({
  effects,
  onChange,
}: {
  effects: LogEffect[];
  onChange: (next: LogEffect[]) => void;
}) {
  const { t, locale } = useI18n();
  const poolsQuery = usePools();
  const conceptsQuery = useConcepts({ page: 1, perPage: 100 });
  const actionsQuery = useActions();

  const pools = poolsQuery.data ?? [];
  const concepts = conceptsQuery.data?.data ?? [];
  const actions = actionsQuery.data ?? [];

  const patch = (index: number, next: LogEffect) =>
    onChange(effects.map((effect, i) => (i === index ? next : effect)));

  return (
    <div className="space-y-2">
      {effects.map((effect, index) => (
        <div key={index} className="rounded-lg border border-line p-2.5">
          <div className="flex gap-2">
            <Select
              value={effect.kind}
              onChange={(e) => {
                const kind = e.target.value as LogEffect['kind'];
                const first = pools[0]?.id ?? '';
                patch(
                  index,
                  kind === 'consume'
                    ? { kind, conceptId: concepts[0]?.id ?? '', quantity: 1 }
                    : kind === 'record_action'
                      ? { kind, actionId: actions[0]?.id ?? '', count: 1 }
                      : kind === 'unit_state'
                        ? { kind, poolId: first, state: 'in_use' }
                        : kind === 'occupancy_open'
                          ? { kind, poolId: first }
                          : kind === 'occupancy_close'
                            ? { kind, poolId: first }
                            : { kind, poolId: first, quantity: 1 },
                );
              }}
            >
              {(
                [
                  'pool_take',
                  'pool_return',
                  'pool_wash',
                  'consume',
                  'record_action',
                  'occupancy_open',
                  'occupancy_close',
                  'unit_state',
                ] as const
              ).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`log.effect.${kind}`)}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onChange(effects.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-2 flex gap-2">
            {'poolId' in effect && (
              <Select
                value={effect.poolId}
                onChange={(e) => patch(index, { ...effect, poolId: e.target.value })}
              >
                {pools.map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {resolveText(pool.name, locale)}
                  </option>
                ))}
              </Select>
            )}
            {effect.kind === 'consume' && (
              <Select
                value={effect.conceptId}
                onChange={(e) => patch(index, { ...effect, conceptId: e.target.value })}
              >
                {concepts.map((concept) => (
                  <option key={concept.id} value={concept.id}>
                    {resolveText(concept.name, locale)}
                  </option>
                ))}
              </Select>
            )}
            {effect.kind === 'record_action' && (
              <Select
                value={effect.actionId}
                onChange={(e) => patch(index, { ...effect, actionId: e.target.value })}
              >
                {actions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {resolveText(action.name, locale)}
                  </option>
                ))}
              </Select>
            )}
            {effect.kind === 'unit_state' && (
              <Select
                value={effect.state}
                onChange={(e) =>
                  patch(index, { ...effect, state: e.target.value as 'available' | 'in_use' | 'dirty' })
                }
              >
                <option value="available">{t('pools.available')}</option>
                <option value="in_use">{t('pools.inUse')}</option>
                <option value="dirty">{t('pools.dirty')}</option>
              </Select>
            )}
            {'quantity' in effect && (
              <Input
                className="w-20"
                type="number"
                min="1"
                value={effect.quantity}
                onChange={(e) =>
                  patch(index, { ...effect, quantity: Number(e.target.value) || 1 })
                }
              />
            )}
            {effect.kind === 'record_action' && (
              <Input
                className="w-20"
                type="number"
                min="1"
                value={effect.count}
                onChange={(e) => patch(index, { ...effect, count: Number(e.target.value) || 1 })}
              />
            )}
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...effects, { kind: 'pool_take', poolId: pools[0]?.id ?? '', quantity: 1 }])
        }
      >
        <Plus className="h-4 w-4" />
        {t('log.addEffect')}
      </Button>
    </div>
  );
}

function EventForm({
  open,
  onClose,
  editing,
  presetName,
}: {
  open: boolean;
  onClose: () => void;
  editing: LogEventDef | null;
  presetName?: string;
}) {
  const { t } = useI18n();
  const createEvent = useCreateLogEvent();
  const updateEvent = useUpdateLogEvent();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [effects, setEffects] = useState<LogEffect[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? presetName ?? '');
    setDescription(editing?.description ?? '');
    setEffects(editing?.effects ?? []);
    setError(null);
  }, [open, editing, presetName]);

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('common.edit') : t('log.newEvent')}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ev-name">{t('log.eventName')}</Label>
          <Input
            id="ev-name"
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={editing !== null}
          />
        </div>
        <div>
          <Label htmlFor="ev-desc">{t('log.description')}</Label>
          <Input
            id="ev-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <Label>{t('log.effects')}</Label>
          <EffectEditor effects={effects} onChange={setEffects} />
          {/* Rule, said plainly where it matters. */}
          <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            {t('log.quantityHint')}
          </p>
        </div>

        {editing && (
          <p className="text-xs text-muted">{t('log.versionHint')}</p>
        )}

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              if (!name.trim() || effects.length === 0) {
                setError(t('log.effects'));
                return;
              }
              try {
                if (editing) {
                  await updateEvent.mutateAsync({
                    id: editing.id,
                    body: { description: description.trim() || null, effects },
                  });
                } else {
                  await createEvent.mutateAsync({
                    name: name.trim(),
                    description: description.trim() || null,
                    shadow: true,
                    effects,
                  });
                }
                onClose();
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.message : String(err));
              }
            }}
            disabled={createEvent.isPending || updateEvent.isPending}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------- page

export function LogPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<LogEventDef | null>(null);
  const [presetName, setPresetName] = useState<string | undefined>();
  const [lineStatus, setLineStatus] = useState<LogLineStatus | ''>('');
  const [pasted, setPasted] = useState('');

  const sourcesQuery = useLogSources(true);
  const healthQuery = useLogHealth();
  const eventsQuery = useLogEvents();
  const unknownQuery = useUnknownEvents(true);
  const linesQuery = useLogLines(lineStatus, true);
  const ingest = useIngest();
  const updateSource = useUpdateLogSource();
  const updateEvent = useUpdateLogEvent();
  const deleteEvent = useDeleteLogEvent();

  const sources = sourcesQuery.data ?? [];
  const events = eventsQuery.data ?? [];
  const unknown = unknownQuery.data ?? [];
  const health = healthQuery.data ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('log.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('log.subtitle')}</p>
        </div>
        <Button onClick={() => setSourceFormOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('log.newSource')}
        </Button>
      </div>

      {/* Silence is the failure mode that does not shout — so it shouts here. */}
      {health
        .filter((entry) => entry.silent)
        .map((entry) => (
          <p
            key={entry.sourceId}
            className="mb-3 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-sm text-text"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
            {entry.name}: {t('log.silent', { n: entry.minutesSinceLastLine ?? 0 })}
          </p>
        ))}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-text">{t('log.sources')}</h2>
        {sourcesQuery.isLoading ? (
          <Spinner />
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted">{t('log.noSources')}</p>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">{source.name}</p>
                    <p className="truncate font-mono text-xs text-muted">{source.path}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] uppercase',
                        source.enabled
                          ? 'bg-success-tint text-success'
                          : 'bg-surface-2 text-muted',
                      )}
                    >
                      {source.enabled ? t('log.enabled') : t('log.disabled')}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateSource.mutate({
                          id: source.id,
                          body: { enabled: !source.enabled },
                        })
                      }
                    >
                      {source.enabled ? t('log.disable') : t('log.enable')}
                    </Button>
                  </div>
                </div>

                <div className="mt-2">
                  <Textarea
                    rows={2}
                    className="font-mono text-xs"
                    placeholder={t('log.paste')}
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                  />
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        const result = await ingest.mutateAsync({
                          id: source.id,
                          content: pasted.trim() || undefined,
                        });
                        toast({
                          message: t('log.result', {
                            applied: result.applied,
                            shadow: result.shadow,
                            unknown: result.unknownEvent,
                            skipped: result.skipped,
                          }),
                          variant: 'success',
                        });
                      }}
                      disabled={ingest.isPending}
                    >
                      <Play className="h-4 w-4" />
                      {t('log.ingest')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        ingest.mutate({ id: source.id, fromStart: true })
                      }
                      disabled={ingest.isPending}
                    >
                      <RefreshCw className="h-4 w-4" />
                      {t('log.replay')}
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted">{t('log.replayHint')}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* The configuration feedback loop, not an error list. */}
      {unknown.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-medium text-text">{t('log.unknownEvents')}</h2>
          <p className="mt-0.5 mb-2 text-xs text-muted">{t('log.unknownHint')}</p>
          <div className="space-y-1.5">
            {unknown.map((entry) => (
              <div
                key={entry.eventName}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2"
              >
                <div className="min-w-0">
                  <code className="font-mono text-sm text-text">{entry.eventName}</code>
                  <span className="ml-2 text-xs text-muted">
                    {t('log.seen', { n: entry.count })}
                  </span>
                  <p className="truncate font-mono text-xs text-muted">{entry.sampleRaw}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingEvent(null);
                    setPresetName(entry.eventName);
                    setEventFormOpen(true);
                  }}
                >
                  {t('log.explain')}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-text">{t('log.dictionary')}</h2>
            <p className="text-xs text-muted">{t('log.dictionaryHint')}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingEvent(null);
              setPresetName(undefined);
              setEventFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('log.newEvent')}
          </Button>
        </div>

        <div className="space-y-1.5">
          {events.map((event) => (
            <div
              key={event.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2"
            >
              <div className="min-w-0">
                <code className="font-mono text-sm text-text">{event.name}</code>
                {event.shadow && (
                  <span className="ml-2 rounded-sm bg-secondary-tint px-1.5 py-0.5 text-[0.65rem] uppercase text-secondary">
                    {t('log.shadowOn')}
                  </span>
                )}
                <p className="truncate text-xs text-muted">
                  {event.description ??
                    event.effects.map((e) => t(`log.effect.${e.kind}`)).join(' · ')}
                  {event.versionCount > 1 && ` · ${event.versionCount} ${t('log.versions')}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {event.shadow && (
                  <Button
                    size="sm"
                    onClick={() =>
                      updateEvent.mutate({ id: event.id, body: { shadow: false } })
                    }
                  >
                    {t('log.enable')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingEvent(event);
                    setPresetName(undefined);
                    setEventFormOpen(true);
                  }}
                >
                  {t('common.edit')}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => deleteEvent.mutate(event.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {events.length > 0 && (
            <p className="pt-1 text-xs text-muted">{t('log.shadowHint')}</p>
          )}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text">{t('log.lines')}</h2>
          <Select
            className="w-auto"
            value={lineStatus}
            onChange={(e) => setLineStatus(e.target.value as LogLineStatus | '')}
          >
            <option value="">{t('common.all')}</option>
            <option value="applied">{t('log.status.applied')}</option>
            <option value="shadow">{t('log.status.shadow')}</option>
            <option value="unknown_event">{t('log.status.unknown_event')}</option>
            <option value="unknown_object">{t('log.status.unknown_object')}</option>
            <option value="error">{t('log.status.error')}</option>
          </Select>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[40rem]">
            <tbody>
              {(linesQuery.data ?? []).map((line) => (
                <tr key={line.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-muted">
                    {formatDateTime(line.occurredAt, locale)}
                  </td>
                  <td className="py-1.5 font-mono text-xs text-text">{line.eventName ?? '—'}</td>
                  <td className="py-1.5 font-mono text-xs text-muted">{line.objectId ?? '—'}</td>
                  <td className="py-1.5">
                    <span
                      className={cn(
                        'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] uppercase whitespace-nowrap',
                        STATUS_STYLE[line.status],
                      )}
                    >
                      {t(`log.status.${line.status}`)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted">{line.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SourceForm open={sourceFormOpen} onClose={() => setSourceFormOpen(false)} />
      <EventForm
        open={eventFormOpen}
        onClose={() => setEventFormOpen(false)}
        editing={editingEvent}
        presetName={presetName}
      />
    </div>
  );
}
