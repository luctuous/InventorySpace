import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import { TOURS } from '../tours';
import type { TourStep } from '../tours';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { Button } from './ui';

// The interactive manual (, block 4). The written manual explains
// the app; this one points at it. A step names a real element by
// `data-tour="…"` — never a class name, which would break the tour the first
// time somebody restyles a button.

const DONE_KEY = 'tours-done';
const CARD_WIDTH = 340;
const GAP = 12;

function loadDone(): string[] {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

interface TourContextValue {
  start: (tourId: string) => void;
  done: string[];
  running: string | null;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}

/**
 * The one on screen — not merely the first in the document.
 *
 * The sidebar is rendered twice (a desktop copy hidden below `md`, and the
 * overlay drawer), so `data-tour="nav"` matches two elements and on a phone
 * the first one is the invisible desktop copy. Picking by document order left
 * the two sidebar steps of the first tour pointing at nothing.
 */
function visibleTarget(selector: string): Element | null {
  for (const element of document.querySelectorAll(`[data-tour="${selector}"]`)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return element;
  }
  return null;
}

/**
 * Wait for the step's element to exist. Pages fetch before they render, so a
 * step that follows a route change has to be patient — but not forever: after
 * the timeout the step still shows, just without a spotlight, which is far
 * better than a tour that stalls on a slow query.
 */
function useTarget(selector: string | undefined, stepIndex: number) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      setSettled(true);
      return;
    }
    setSettled(false);
    setRect(null);

    let raf = 0;
    const deadline = Date.now() + 4000;

    const find = () => {
      const element = visibleTarget(selector);
      if (element) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setRect(element.getBoundingClientRect());
        setSettled(true);
        return;
      }
      if (Date.now() > deadline) {
        setSettled(true);
        return;
      }
      raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [selector, stepIndex]);

  // Keep the hole over the element while the page moves under it.
  useEffect(() => {
    if (!selector || !settled) return;
    const track = () => {
      const element = visibleTarget(selector);
      setRect(element ? element.getBoundingClientRect() : null);
    };
    const id = window.setInterval(track, 250);
    window.addEventListener('resize', track);
    window.addEventListener('scroll', track, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', track);
      window.removeEventListener('scroll', track, true);
    };
  }, [selector, settled]);

  return { rect, settled };
}

const CARD_HEIGHT = 240; // enough to decide whether a side has room

/** Below the target if it fits, above if not, centred if there is no target. */
function cardPosition(rect: DOMRect | null): React.CSSProperties {
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const clampTop = (value: number) =>
    Math.min(Math.max(GAP, value), Math.max(GAP, window.innerHeight - CARD_HEIGHT - GAP));

  // A tall target — a sidebar, a whole table — has no "above" or "below" worth
  // using: the card would land on top of the thing it is pointing at.
  if (rect.height > window.innerHeight * 0.5) {
    const right = rect.right + GAP;
    const left =
      right + CARD_WIDTH < window.innerWidth ? right : Math.max(GAP, rect.left - CARD_WIDTH - GAP);
    return { top: clampTop(rect.top), left };
  }

  const below = rect.bottom + GAP;
  const top =
    window.innerHeight - below > CARD_HEIGHT ? below : clampTop(rect.top - GAP - CARD_HEIGHT);

  const wanted = rect.left + rect.width / 2 - CARD_WIDTH / 2;
  const left = Math.min(Math.max(GAP, wanted), window.innerWidth - CARD_WIDTH - GAP);
  return { top, left };
}

function Spotlight({ rect }: { rect: DOMRect }) {
  const pad = 6;
  const box = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  // Four panels around the target rather than one box-shadow: the shadow
  // approach clips at the viewport edge on a phone, this never does.
  const shade = 'fixed bg-black/55 transition-all duration-200';
  return (
    <>
      <div className={shade} style={{ top: 0, left: 0, right: 0, height: Math.max(0, box.top) }} />
      <div className={shade} style={{ top: box.top + box.height, left: 0, right: 0, bottom: 0 }} />
      <div className={shade} style={{ top: box.top, left: 0, width: Math.max(0, box.left), height: box.height }} />
      <div className={shade} style={{ top: box.top, left: box.left + box.width, right: 0, height: box.height }} />
      <div
        className="pointer-events-none fixed rounded-md ring-2 ring-primary transition-all duration-200"
        style={box}
      />
    </>
  );
}

function TourOverlay({
  tourId,
  onClose,
  onComplete,
  setNavOpen,
}: {
  tourId: string;
  onClose: () => void;
  onComplete: (tourId: string) => void;
  setNavOpen: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);

  const tour = TOURS.find((candidate) => candidate.id === tourId);
  const steps: TourStep[] = tour?.steps ?? [];
  const step = steps[index];

  // Reveal before looking: on a phone the sidebar is a drawer, so a step about
  // the menu has to open it or it points at nothing. Harmless on a desktop,
  // where the drawer is display:none and the permanent sidebar is found
  // instead.
  useEffect(() => {
    setNavOpen(step?.needsNav === true);
  }, [step, setNavOpen]);

  const { rect } = useTarget(step?.target, index);

  // Route first, then look for the element — otherwise every step after a
  // navigation would search the page it is leaving.
  const routeRef = useRef<string | null>(null);
  useEffect(() => {
    if (step?.route && routeRef.current !== step.route) {
      routeRef.current = step.route;
      navigate(step.route);
    }
  }, [step, navigate]);

  const finish = useCallback(() => {
    setNavOpen(false);
    onComplete(tourId);
    onClose();
  }, [onComplete, onClose, setNavOpen, tourId]);

  // Leaving early must not strand the drawer open either.
  const quit = useCallback(() => {
    setNavOpen(false);
    onClose();
  }, [onClose, setNavOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') quit();
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, steps.length - 1));
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quit, steps.length]);

  if (!step) return null;
  const last = index === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[60]">
      {rect ? <Spotlight rect={rect} /> : <div className="fixed inset-0 bg-black/55" />}

      <div
        role="dialog"
        aria-modal="true"
        data-ui="tour"
        className="fixed rounded-xl border border-line bg-surface p-4 shadow-xl"
        style={{ width: CARD_WIDTH, ...cardPosition(rect) }}
      >
        <div className="mb-2 flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-base font-semibold text-text">
            {t(`tour.${tourId}.${step.key}.title`)}
          </h3>
          <button
            onClick={quit}
            title={t('tour.skip')}
            className="cursor-pointer rounded p-0.5 text-muted hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm leading-relaxed text-muted">
          {t(`tour.${tourId}.${step.key}.body`)}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <span className="font-mono text-xs text-muted">
            {index + 1} / {steps.length}
          </span>
          <div className="ml-auto flex gap-2">
            {index > 0 && (
              <Button size="sm" variant="outline" onClick={() => setIndex(index - 1)}>
                <ArrowLeft className="h-4 w-4" /> {t('tour.back')}
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? (
                <>
                  <Check className="h-4 w-4" /> {t('tour.finish')}
                </>
              ) : (
                <>
                  {t('tour.next')} <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TourProvider({
  children,
  setNavOpen = () => {},
}: {
  children: ReactNode;
  /** Lets a step open the sidebar drawer — see `needsNav` in tours.ts. */
  setNavOpen?: (open: boolean) => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>(loadDone);

  const complete = useCallback((tourId: string) => {
    setDone((previous) => {
      if (previous.includes(tourId)) return previous;
      const next = [...previous, tourId];
      try {
        localStorage.setItem(DONE_KEY, JSON.stringify(next));
      } catch {
        // A locked-down browser is not a reason to break the tour.
      }
      return next;
    });
  }, []);

  return (
    <TourContext.Provider value={{ start: setRunning, done, running }}>
      {children}
      {running && (
        <TourOverlay
          tourId={running}
          onClose={() => setRunning(null)}
          onComplete={complete}
          setNavOpen={setNavOpen}
        />
      )}
    </TourContext.Provider>
  );
}

/** The list behind the “?” in the sidebar: the written manual, then the tours. */
export function HelpMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { t, locale } = useI18n();
  const { start, done } = useTour();

  return (
    <div className="w-64 rounded-lg border border-line bg-surface p-1.5 shadow-xl">
      <a
        href={`/api/v1/manual/${locale}`}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        className="block rounded-md px-2.5 py-2 text-sm text-text hover:bg-surface-2"
      >
        {t('manual.open')}
        <span className="block text-xs text-muted">{t('manual.hint')}</span>
      </a>

      {/* The architecture manual. It sits under the same "?" because somebody
          looking for how the app works should not have to know there are two
          documents — but second, because most people never need it. */}
      <a
        href={`/api/v1/manual/code/${locale}`}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        className="block rounded-md px-2.5 py-2 text-sm text-text hover:bg-surface-2"
      >
        {t('manual.openCode')}
        <span className="block text-xs text-muted">{t('manual.codeHint')}</span>
      </a>

      <p className="px-2.5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted">
        {t('tour.title')}
      </p>
      {TOURS.map((tour) => (
        <button
          key={tour.id}
          onClick={() => {
            start(tour.id);
            onNavigate?.();
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-text hover:bg-surface-2"
        >
          <span className="min-w-0 flex-1">
            {t(`tour.${tour.id}.title`)}
            <span className="block text-xs text-muted">
              {t('tour.steps', { n: tour.steps.length })}
            </span>
          </span>
          {done.includes(tour.id) && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
        </button>
      ))}
    </div>
  );
}

/**
 * Shown on Home until somebody has finished — or dismissed — the first tour.
 * One strip, once, never again: an app that keeps offering help you already
 * declined is an app that does not listen.
 */
export function TourInvite() {
  const { t } = useI18n();
  const { start, done } = useTour();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('tour-invite-dismissed') === '1',
  );

  if (dismissed || done.length > 0) return null;
  const first = TOURS[0];
  if (!first) return null;

  const hide = () => {
    localStorage.setItem('tour-invite-dismissed', '1');
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        'mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30',
        'bg-primary-tint px-4 py-3',
      )}
    >
      <p className="min-w-0 flex-1 text-sm text-text">{t('tour.inviteBody')}</p>
      <Button
        size="sm"
        onClick={() => {
          start(first.id);
          hide();
        }}
      >
        {t('tour.inviteStart')}
      </Button>
      <button
        onClick={hide}
        className="cursor-pointer rounded p-1 text-muted hover:text-text"
        title={t('tour.skip')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
