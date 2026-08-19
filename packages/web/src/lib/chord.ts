// Reading a key chord off the keyboard.
//
// A chord is two groups of keys, each held down together for a moment:
// press `s w x`, hold, release; press `i k o`, hold, release — signed in.
//
// Two things make this harder than it sounds. Keys never land at the same
// millisecond, so "held together" has to mean "still down after a short
// pause". And a group has to end when the fingers lift, not when the timer
// fires, or a slow hand would be read as two groups.

/** Physical key positions, so a chord works on any keyboard layout. */
function keyOf(event: KeyboardEvent): string | null {
  const match = /^Key([A-Z])$/.exec(event.code);
  return match?.[1]?.toLowerCase() ?? null;
}

/** `['e','w','d']` → `d+e+w` — the same normalization the server does. */
function normalizeGroup(keys: Iterable<string>): string {
  return [...new Set(keys)].sort().join('+');
}

export interface ChordOptions {
  /** How long the keys must stay down before the group counts. */
  holdMs: number;
  /** How long you have to start the second group after releasing the first. */
  gapMs: number;
  /** Called with `s+w+x i+k+o` once both groups are in. */
  onChord: (chord: string) => void;
}

export const CHORD_DEFAULTS = { holdMs: 350, gapMs: 1500 };
export const GROUPS_PER_CHORD = 2;
/** Fewer keys than this is typing, not a chord. */
const MIN_GROUP_SIZE = 2;

/**
 * Listens on `window` and calls `onChord` when a full chord is entered.
 * Returns the teardown function.
 *
 * It stays quiet while the focus is in a text field. Holding three letters
 * down in a search box is not something anybody does on purpose, but it *is*
 * something that would put three letters in the box, and a login shortcut has
 * no business eating what somebody typed.
 */
export function listenForChords(options: ChordOptions): () => void {
  const { holdMs, gapMs, onChord } = options;

  let down = new Set<string>();
  let holdTimer: number | null = null;
  /** The group captured by the timer, waiting for the fingers to lift. */
  let held: string | null = null;
  let groups: string[] = [];
  let gapTimer: number | null = null;

  const clearHold = () => {
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    holdTimer = null;
  };
  const reset = () => {
    clearHold();
    if (gapTimer !== null) window.clearTimeout(gapTimer);
    gapTimer = null;
    down = new Set();
    held = null;
    groups = [];
  };

  const isTyping = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    if (!element || typeof element.closest !== 'function') return false;
    // A field can opt back in with `data-chord-ok`. The sign-in form does,
    // because that is where the cursor lands by itself: somebody arriving at
    // a signed-out screen clicks the username box out of habit and then
    // presses their chord, and refusing to read it there would break the one
    // place the shortcut exists for.
    if (element.closest('[data-chord-ok]')) return false;
    // Sliders, checkboxes and buttons swallow nothing, so a chord is still a
    // chord while one of them has focus — only text entry is protected.
    return Boolean(
      element.closest(
        'textarea, select, [contenteditable="true"], ' +
          'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"])',
      ),
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    // A chord is bare letters. Anything with a modifier is a real shortcut
    // (Ctrl+S, Alt+Tab) and must pass straight through.
    if (event.ctrlKey || event.metaKey || event.altKey) return reset();
    const key = keyOf(event);
    if (!key || isTyping(event.target)) return reset();

    down.add(key);
    held = null;
    // Every new key restarts the clock: the group is whatever is still down
    // once the hand stops moving.
    clearHold();
    holdTimer = window.setTimeout(() => {
      if (down.size >= MIN_GROUP_SIZE) held = normalizeGroup(down);
    }, holdMs);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const key = keyOf(event);
    if (!key) return;
    down.delete(key);
    if (down.size > 0) return; // still mid-group

    clearHold();
    if (!held) {
      // Lifted too early, or too few keys — not a group, so the chord dies
      // here rather than silently pairing with whatever comes next.
      groups = [];
      return;
    }

    groups.push(held);
    held = null;

    if (groups.length === GROUPS_PER_CHORD) {
      const chord = groups.join(' ');
      reset();
      onChord(chord);
      return;
    }

    if (gapTimer !== null) window.clearTimeout(gapTimer);
    gapTimer = window.setTimeout(() => {
      groups = [];
    }, gapMs);
  };

  // Alt-tabbing away mid-chord must not leave half a chord waiting.
  const onBlur = () => reset();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    reset();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

// ------------------------------------------------------------- suspending
//
// While you are practising your chord on the account screen, pressing it must
// not sign you out — which is exactly what the app-wide listener would do. So
// the practice screen suspends it. A counter rather than a flag, because two
// things could suspend at once and the second one closing must not re-arm the
// listener under the first.

let suspensions = 0;

export function suspendChords(): () => void {
  suspensions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspensions -= 1;
  };
}

export function chordsSuspended(): boolean {
  return suspensions > 0;
}

// --------------------------------------------------------- device settings
//
// The hold time is stored on the device, not on the account, and that is
// forced rather than chosen: at the login screen nobody knows yet *whose*
// setting to apply. It is a property of this keyboard and the hands using it.

const HOLD_KEY = 'inventory.fastKey.holdMs';
/** The app-wide listener re-arms on this, so a new hold time takes effect now. */
export const HOLD_CHANGED = 'inventory:fast-key-hold-changed';

export function readHoldMs(): number {
  const raw = Number(localStorage.getItem(HOLD_KEY));
  return Number.isFinite(raw) && raw >= 120 && raw <= 1200 ? raw : CHORD_DEFAULTS.holdMs;
}

export function writeHoldMs(value: number): void {
  localStorage.setItem(HOLD_KEY, String(Math.round(value)));
  window.dispatchEvent(new Event(HOLD_CHANGED));
}

/**
 * `e+f+w i+k+o` → `[['W','E','F'], ['I','O','K']]`, for drawing key caps.
 *
 * Stored chords are sorted alphabetically, which is right for comparing them
 * and wrong for looking at them: nobody finds `E F W` on a keyboard. The caps
 * are re-sorted into reading order — top row first, then left to right —
 * so what is on screen is the shape the hand makes.
 */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function keyboardOrder(key: string): number {
  for (let row = 0; row < KEYBOARD_ROWS.length; row++) {
    const column = KEYBOARD_ROWS[row]?.indexOf(key) ?? -1;
    if (column >= 0) return row * 100 + column;
  }
  return 999;
}

export function chordKeyCaps(chord: string): string[][] {
  return chord
    .split(' ')
    .map((group) =>
      group
        .split('+')
        .sort((a, b) => keyboardOrder(a) - keyboardOrder(b))
        .map((key) => key.toUpperCase()),
    );
}
