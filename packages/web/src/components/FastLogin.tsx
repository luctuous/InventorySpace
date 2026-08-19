import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { authClient } from '../api/auth';
import { useI18n } from '../i18n';
import {
  CHORD_DEFAULTS,
  HOLD_CHANGED,
  chordsSuspended,
  listenForChords,
  readHoldMs,
} from '../lib/chord';
import { readClaim } from '../lib/device';
import { useToast } from './toast';

// Fast login, listening app-wide.
//
// It sits above the router rather than inside a page, because the whole point
// is that it works everywhere: at the login screen, and in the middle of the
// Items table when the next person on shift wants the machine.

interface ChordResult {
  action?: 'signed-in' | 'signed-out';
  name?: string;
}

export function FastLoginListener() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [holdMs, setHoldMs] = useState(readHoldMs);
  // The listener is registered once; without this the callback would close
  // over a stale `busy` and a chord pressed twice quickly would fire twice.
  const busyRef = useRef(false);

  // Moving the hold-time slider must change how this listener reads, not just
  // how the practice strip reads.
  useEffect(() => {
    const sync = () => setHoldMs(readHoldMs());
    window.addEventListener(HOLD_CHANGED, sync);
    return () => window.removeEventListener(HOLD_CHANGED, sync);
  }, []);

  useEffect(() => {
    const submit = async (chord: string) => {
      // Somebody is practising their chord on the account screen — that screen
      // answers them, and this listener must stay out of it.
      if (chordsSuspended() || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const response = await fetch('/api/auth/sign-in/fast-key', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          // Who has claimed this computer, so a chord pressed at your own desk
          // keeps the lasting session instead of quietly downgrading it. The
          // server only honours it when it matches the chord's owner.
          body: JSON.stringify({ chord, rememberDeviceFor: readClaim()?.userId }),
        });
        const payload = (await response.json().catch(() => ({}))) as ChordResult & {
          message?: string;
        };

        if (!response.ok) {
          // A wrong chord is usually a slip, not an attack, and the person
          // needs to know it did not take — silence would leave them typing
          // into a session that is not theirs.
          toast({
            message: response.status === 429 ? t('fastKey.throttled') : t('fastKey.unknown'),
            variant: 'danger',
          });
          return;
        }

        // The session changed underneath every cached query.
        await authClient.getSession({ query: { disableCookieCache: true } });
        queryClient.clear();

        if (payload.action === 'signed-out') {
          toast({ message: t('fastKey.signedOut', { name: payload.name ?? '' }) });
          navigate('/login');
        } else {
          toast({
            message: t('fastKey.signedIn', { name: payload.name ?? '' }),
            variant: 'success',
          });
          navigate('/');
        }
      } catch {
        toast({ message: t('fastKey.failed'), variant: 'danger' });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };

    return listenForChords({
      holdMs,
      gapMs: CHORD_DEFAULTS.gapMs,
      onChord: (chord) => void submit(chord),
    });
  }, [holdMs, navigate, queryClient, t, toast]);

  if (!busy) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 animate-pulse bg-primary" />
  );
}
