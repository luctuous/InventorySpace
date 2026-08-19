import { useEffect, useState } from 'react';
import { Check, KeySquare, RefreshCw, Trash2 } from 'lucide-react';
import { ApiRequestError } from '../api/client';
import { useDropFastKey, useGenerateFastKey, useMyFastKey } from '../api/entities';
import { useI18n } from '../i18n';
import {
  CHORD_DEFAULTS,
  chordKeyCaps,
  listenForChords,
  readHoldMs,
  suspendChords,
  writeHoldMs,
} from '../lib/chord';
import { useToast } from './toast';
import { Button, Label, Modal, Spinner } from './ui';

// Your key chord: see it, swap it for another, throw it away,
// and — the part that actually makes people trust it — try it out without
// being signed out for getting it wrong.

/** The chord drawn as it is pressed: two clusters, keys inside each held together. */
function ChordCaps({ chord, dim }: { chord: string; dim?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-3">
      {chordKeyCaps(chord).map((group, index) => (
        <div key={index} className="flex items-center gap-3">
          {index > 0 && <span className="text-xs text-muted">{t('fastKey.then')}</span>}
          <div className="flex gap-1">
            {group.map((key) => (
              <kbd
                key={key}
                className={
                  'flex h-10 w-10 items-center justify-center rounded-md border-b-2 font-mono text-base font-semibold ' +
                  (dim
                    ? 'border-line bg-surface-2 text-muted'
                    : 'border-primary bg-primary-tint text-primary')
                }
              >
                {key}
              </kbd>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function FastKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, isLoading } = useMyFastKey();
  const generate = useGenerateFastKey();
  const drop = useDropFastKey();
  const [holdMs, setHoldMs] = useState(readHoldMs);
  const [practised, setPractised] = useState<'match' | 'miss' | null>(null);

  const chord = data?.chord ?? null;

  // Practice mode. It listens for the same chords the real listener does, but
  // this one only ever says yes or no — which is the difference between
  // learning a gesture and gambling with your session.
  useEffect(() => {
    if (!open || !chord) return;
    setPractised(null);
    const resume = suspendChords();
    const stop = listenForChords({
      holdMs,
      gapMs: CHORD_DEFAULTS.gapMs,
      onChord: (entered) => setPractised(entered === chord ? 'match' : 'miss'),
    });
    return () => {
      stop();
      resume();
    };
  }, [open, chord, holdMs]);

  const run = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      setPractised(null);
      toast({ message, variant: 'success' });
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('fastKey.title')}>
      <div className="space-y-5">
        <p className="text-sm text-muted">{t('fastKey.intro')}</p>

        {isLoading ? (
          <Spinner className="h-5 w-5" />
        ) : chord ? (
          <>
            <div className="rounded-lg border border-line bg-surface-2 p-4">
              <ChordCaps chord={chord} />
              <p className="mt-3 text-xs text-muted">{t('fastKey.howToPress')}</p>
            </div>

            {/* The practice strip. Nothing here signs anybody in or out. */}
            <div className="flex items-center gap-2 text-sm">
              {practised === 'match' ? (
                <span className="flex items-center gap-1.5 text-success">
                  <Check className="h-4 w-4" /> {t('fastKey.practiceMatch')}
                </span>
              ) : practised === 'miss' ? (
                <span className="text-warning">{t('fastKey.practiceMiss')}</span>
              ) : (
                <span className="text-muted">{t('fastKey.practiceHint')}</span>
              )}
            </div>

            <div>
              <Label htmlFor="fk-hold">{t('fastKey.holdTime', { ms: String(holdMs) })}</Label>
              <input
                id="fk-hold"
                type="range"
                min={150}
                max={800}
                step={50}
                value={holdMs}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setHoldMs(next);
                  writeHoldMs(next);
                  setPractised(null);
                }}
                className="w-full accent-[var(--color-primary)]"
              />
              <p className="text-xs text-muted">{t('fastKey.holdNote')}</p>
            </div>

            <p className="rounded-md bg-warning-tint p-3 text-xs text-text">
              {t('fastKey.warning')}
            </p>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => void run(() => drop.mutateAsync(), t('fastKey.removed'))}
                disabled={drop.isPending}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> {t('fastKey.remove')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void run(() => generate.mutateAsync(), t('fastKey.regenerated'))}
                disabled={generate.isPending}
              >
                <RefreshCw className="mr-1.5 h-4 w-4" /> {t('fastKey.regenerate')}
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('fastKey.none')}</p>
            <Button
              onClick={() => void run(() => generate.mutateAsync(), t('fastKey.created'))}
              disabled={generate.isPending}
            >
              <KeySquare className="mr-1.5 h-4 w-4" /> {t('fastKey.create')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
