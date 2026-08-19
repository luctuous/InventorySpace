import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { idRegistry } from '../db/schema';

// Human IDs. Two styles, one registry:
//   lettered: supplyAA001 … supplyAA999 → supplyAB001 … supplyZZ999
//   simple:   CON001, ANA001, VAR001 … (number just keeps growing)
// MUST be called inside the same transaction as the INSERT that uses the id —
// better-sqlite3 is synchronous, so the registry update and the insert commit
// or roll back together.

export type IdStyle = 'lettered' | 'simple';

function nextLetters(letters: string): string {
  // AA → AB … AZ → BA … ZZ → error (676 × 999 ids exhausted)
  const chars = letters.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
  }
  throw new Error(`Human ID letter space exhausted after ${letters}`);
}

export function generateHumanId(prefix: string, style: IdStyle): string {
  const row = db
    .select()
    .from(idRegistry)
    .where(eq(idRegistry.prefix, prefix))
    .get();

  let letterPart: string;
  let numberPart: number;

  if (!row) {
    letterPart = style === 'lettered' ? 'AA' : '';
    numberPart = 1;
  } else {
    letterPart = row.letterPart;
    numberPart = row.numberPart + 1;
    if (style === 'lettered' && numberPart > 999) {
      letterPart = nextLetters(letterPart);
      numberPart = 1;
    }
  }

  const humanId = `${prefix}${letterPart}${String(numberPart).padStart(3, '0')}`;

  db.insert(idRegistry)
    .values({ prefix, letterPart, numberPart, lastId: humanId })
    .onConflictDoUpdate({
      target: idRegistry.prefix,
      set: { letterPart, numberPart, lastId: humanId },
    })
    .run();

  return humanId;
}
