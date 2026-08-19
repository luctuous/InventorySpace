import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { IDLE_TIMEOUT_MS, IDLE_WARNING_MS } from '@inventory/shared';
import { authClient } from '../api/auth';
import { useI18n } from '../i18n';
import { claimedBy } from '../lib/device';
import { Button, Modal } from './ui';

// Twenty minutes of silence ends a session on a shared computer.
//
// The bench machine problem is not theft, it is attribution: a browser left
// signed in makes every depletion, every move and every adjustment look like
// the work of whoever walked away last, and History is the one thing in this
// product that has to be trustworthy.
//
// A computer somebody has claimed is exempt — that is the entire point of
// claiming it — so this hook does nothing at all there.

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function IdleTimer({ userId }: { userId: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  // Read by the interval without re-subscribing it on every tick.
  const lastActive = useRef(Date.now());

  const exempt = userId === null || claimedBy(userId);

  const signOut = useCallback(async () => {
    setSecondsLeft(null);
    await authClient.signOut();
    // The next person must not inherit a cache full of somebody else's data.
    queryClient.clear();
    navigate('/login?idle=1', { replace: true });
  }, [navigate, queryClient]);

  useEffect(() => {
    if (exempt) return;

    const touch = () => {
      lastActive.current = Date.now();
      setSecondsLeft(null);
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, touch, { passive: true });
    }
    // Coming back to the tab counts as being here. It also matters after a
    // laptop lid closes: timers do not run reliably while suspended, so the
    // check below is against the clock, never against a countdown.
    document.addEventListener('visibilitychange', touch);

    const tick = window.setInterval(() => {
      const idleFor = Date.now() - lastActive.current;
      if (idleFor >= IDLE_TIMEOUT_MS) {
        void signOut();
        return;
      }
      const remaining = IDLE_TIMEOUT_MS - idleFor;
      setSecondsLeft(remaining <= IDLE_WARNING_MS ? Math.ceil(remaining / 1000) : null);
    }, 1000);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch);
      document.removeEventListener('visibilitychange', touch);
      window.clearInterval(tick);
    };
  }, [exempt, signOut]);

  if (secondsLeft === null) return null;

  return (
    <Modal open onClose={() => (lastActive.current = Date.now())} title={t('auth.idleTitle')}>
      <div className="space-y-4">
        <p className="flex items-start gap-2.5 text-sm text-text">
          <Timer className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {t('auth.idleBody', { seconds: secondsLeft })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => void signOut()}>
            {t('auth.signOut')}
          </Button>
          <Button
            onClick={() => {
              lastActive.current = Date.now();
              setSecondsLeft(null);
            }}
          >
            {t('auth.idleStay')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
