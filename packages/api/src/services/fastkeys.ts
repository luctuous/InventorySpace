import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { fastKeys } from '../db/schema';
import { ApiError } from '../middleware/error';

// Fast login. A chord is two groups of keys, each pressed and
// held together for a moment. The machine picks it, never the person, for one
// reason: chords must be unique across everyone in the workshop, and a human
// choosing their own would collide, discover it, and have to choose again.
//
// The interesting constraint is not uniqueness though — it is that the chord
// has to be *comfortable*. A generator that returns `a+y+ñ` is useless: nobody
// can hold that with one hand. So the letters are not drawn from the alphabet;
// they are drawn from the keyboard, by position.

/**
 * The keyboard as fingers see it: five columns per hand, three rows deep.
 * Positions, not characters — the web side reads `event.code`, so `KeyQ` is
 * the top-left key whether the cap says Q, A or Й.
 *
 * The right hand is one key short on the bottom row and two on the home row;
 * that is simply where the punctuation starts, and punctuation is not
 * comfortable, so those slots stay empty.
 */
const LEFT_COLUMNS = [
  ['q', 'a', 'z'],
  ['w', 's', 'x'],
  ['e', 'd', 'c'],
  ['r', 'f', 'v'],
  ['t', 'g', 'b'],
];
const RIGHT_COLUMNS = [
  ['y', 'h', 'n'],
  ['u', 'j', 'm'],
  ['i', 'k'],
  ['o', 'l'],
  ['p'],
];

const GROUP_SIZE = 3;

/**
 * Every group a hand can actually hold: one key per column, three adjacent
 * columns, and no two fingers more than one row apart. That last rule is what
 * rejects `q+s+c` (a diagonal across the whole hand) while keeping `w+d+c`
 * (three neighbours, a natural claw).
 *
 * One key per column matters more than it looks: two keys in the same column
 * would be one finger pressing two keys, which is not a chord, it is a typo.
 */
function groupsFor(columns: string[][]): string[][] {
  const groups: string[][] = [];
  for (let start = 0; start + GROUP_SIZE <= columns.length; start++) {
    const window = columns.slice(start, start + GROUP_SIZE);
    const walk = (index: number, keys: string[], rows: number[]) => {
      const column = window[index];
      if (!column) {
        groups.push(keys);
        return;
      }
      for (let row = 0; row < column.length; row++) {
        const key = column[row];
        if (!key) continue;
        const nextRows = [...rows, row];
        if (Math.max(...nextRows) - Math.min(...nextRows) > 1) continue;
        walk(index + 1, [...keys, key], nextRows);
      }
    };
    walk(0, [], []);
  }
  return groups;
}

const ALL_GROUPS = [...groupsFor(LEFT_COLUMNS), ...groupsFor(RIGHT_COLUMNS)];

/** `['e','w','d']` → `d+e+w`. Sorting is what makes the chord order-free. */
export function normalizeGroup(keys: string[]): string {
  return [...new Set(keys)].sort().join('+');
}

/** `[['w','s','x'], ['i','k','o']]` → `s+w+x i+k+o`. */
export function normalizeChord(groups: string[][]): string {
  return groups.map(normalizeGroup).join(' ');
}

/**
 * How many distinct chords exist. Exported because it is the honest measure of
 * how guessable a chord is, and the manual quotes it rather than hand-waving.
 */
export function chordSpace(): number {
  return ALL_GROUPS.length * (ALL_GROUPS.length - 1);
}

function pick<T>(list: T[], fallback: T): T {
  return list[Math.floor(Math.random() * list.length)] ?? fallback;
}

/**
 * A chord nobody else has. The two groups are always different, so no chord is
 * "the same thing twice" — and the second group is preferably on the other
 * hand, which is both faster to press and easier to remember as a rhythm.
 */
export function generateChord(): string {
  const taken = new Set(db.select({ chord: fastKeys.chord }).from(fastKeys).all().map((r) => r.chord));
  const anyGroup = ALL_GROUPS[0] ?? ['a', 's', 'd'];

  for (let attempt = 0; attempt < 200; attempt++) {
    const first = pick(ALL_GROUPS, anyGroup);
    // Same hand is allowed as a fallback, but alternating hands is the default:
    // your left hand is already lifting while your right hand lands.
    const otherHand = ALL_GROUPS.filter((group) => sameHand(group) !== sameHand(first));
    const second = pick(attempt < 150 ? otherHand : ALL_GROUPS, anyGroup);
    if (normalizeGroup(first) === normalizeGroup(second)) continue;
    const chord = normalizeChord([first, second]);
    if (!taken.has(chord)) return chord;
  }
  throw new ApiError(
    409,
    'chord_space_exhausted',
    'No unused key chord is left — remove an old one before creating another',
  );
}

function sameHand(group: string[]): 'left' | 'right' {
  const first = group[0] ?? '';
  return LEFT_COLUMNS.some((column) => column.includes(first)) ? 'left' : 'right';
}

// ------------------------------------------------------------------ storage

export function getFastKey(userId: string) {
  return db.select().from(fastKeys).where(eq(fastKeys.userId, userId)).get() ?? null;
}

/** Replaces whatever that person had; regenerating is one click by design. */
export function setFastKey(userId: string): { chord: string; createdAt: Date } {
  const chord = generateChord();
  const createdAt = new Date();
  db.delete(fastKeys).where(eq(fastKeys.userId, userId)).run();
  db.insert(fastKeys).values({ id: randomUUID(), userId, chord, createdAt }).run();
  return { chord, createdAt };
}

export function clearFastKey(userId: string): void {
  db.delete(fastKeys).where(eq(fastKeys.userId, userId)).run();
}

/** The sign-in lookup: chord → who that is. Null means nobody. */
export function userIdForChord(chord: string): string | null {
  const row = db.select().from(fastKeys).where(eq(fastKeys.chord, chord)).get();
  return row?.userId ?? null;
}
