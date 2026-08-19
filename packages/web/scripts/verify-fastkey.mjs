// Fast login by key chord, driven with a real keyboard in a
// real browser — because everything interesting about this feature happens
// between keydown and keyup, and no API test can see it.
//
// Usage: node scripts/verify-fastkey.mjs [baseUrl] [user] [pass]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It generates a chord
// for the account it signs in as, which replaces whatever that person had.
// Point it at a scratch copy:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   # in packages/api, serving the built SPA on one port:
//   SERVE_WEB=1 WEB_DIST=../web/dist DATABASE_PATH=/tmp/scratch.db PORT=3003 npx tsx src/index.ts
//   node scripts/verify-fastkey.mjs http://localhost:3003
//
// It needs the single-port build (the Vite dev server on 5173 proxies to
// whichever API is on 3001, which is usually the real one).
//
// Exits non-zero if anything failed.

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3003';
const USER = process.argv[3] ?? 'demoadmin';
const PASS = process.argv[4] ?? 'test-1234-test';
/** Comfortably longer than the app's 350 ms default, so timing is never the variable. */
const HOLD = 550;

console.log(`\n→ ${BASE} — this writes to that database\n`);

const results = [];
const ok = (name, extra = '') => {
  results.push('PASS');
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  results.push('FAIL');
  console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

async function pressGroup(keys) {
  for (const key of keys) await page.keyboard.down(`Key${key.toUpperCase()}`);
  await page.waitForTimeout(HOLD + 200);
  for (const key of keys) await page.keyboard.up(`Key${key.toUpperCase()}`);
}
async function pressChord(chord) {
  const [first, second] = chord.split(' ');
  await pressGroup(first.split('+'));
  await page.waitForTimeout(150);
  await pressGroup(second.split('+'));
  await page.waitForTimeout(1400);
}

try {
  // ------------------------------------------------ the sign-in form itself
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('form');

  const label = (await page.textContent('label[for="identifier"]')) ?? '';
  /user|usuari|nutzer/i.test(label)
    ? ok('the sign-in field asks for a username', label)
    : bad('the sign-in field still asks for something else', label);

  (await page.getAttribute('#identifier', 'type')) === 'text'
    ? ok('the username field is plain text, not an email field')
    : bad('the username field is still typed as an email');

  (await page.locator('text=/fast login key|clau d|Tastengriff/i').count()) > 0
    ? ok('the sign-in screen says a chord will work')
    : bad('nothing on the sign-in screen mentions the chord');

  // ------------------------------------------------------ get oneself a chord
  await page.fill('#identifier', USER);
  await page.fill('#password', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);

  await page.click('button[title*="ast" i], button[title*="chnell" i]');
  await page.waitForSelector('[data-ui="modal"]');
  const makeButton = page
    .locator('[data-ui="modal"] button:has-text("another"), [data-ui="modal"] button:has-text("altra"), [data-ui="modal"] button:has-text("anderen"), [data-ui="modal"] button:has-text("Create"), [data-ui="modal"] button:has-text("Crea"), [data-ui="modal"] button:has-text("erstellen")')
    .first();
  await makeButton.click();
  await page.waitForTimeout(1000);

  const caps = await page.locator('[data-ui="modal"] kbd').allTextContents();
  caps.length === 6
    ? ok('the chord is drawn as six key caps', caps.join(''))
    : bad('the chord is not six key caps', String(caps.length));

  // The API is the authority on what the chord *is*; the caps are re-sorted
  // into keyboard order for reading, so they cannot be compared directly.
  const chord = await page.evaluate(async () => {
    const response = await fetch('/api/v1/users/me/fast-key', { credentials: 'include' });
    return (await response.json()).chord;
  });
  /^[a-z](\+[a-z])* [a-z](\+[a-z])*$/.test(chord ?? '')
    ? ok('the chord is well formed', chord)
    : bad('the chord is malformed', String(chord));

  // ------------------------------------------------------------- practising
  await page.locator('[data-ui="modal"]').click({ position: { x: 5, y: 5 } });
  await pressChord(chord);
  (await page.locator('text=/That was it|Era aquesta|Das war er/').count()) > 0
    ? ok('practice recognises the chord')
    : bad('practice did not recognise the chord');
  new URL(page.url()).pathname === '/'
    ? ok('practising does not sign anybody out')
    : bad('practising signed the user out', page.url());

  // ------------------------------------------------- the chord as a sign-out
  await page.keyboard.press('Escape');
  // Wait for the dialog to actually be gone, not for a hopeful 400 ms. While it
  // is open it suspends the app-wide listener on purpose (chord.ts), so a
  // chord pressed a frame too early is correctly ignored — and the suite then
  // fails somewhere else entirely, looking like a session bug.
  await page.locator('[data-ui="modal"]').waitFor({ state: 'detached', timeout: 5000 });
  await page.mouse.click(5, 5);
  await pressChord(chord);
  new URL(page.url()).pathname === '/login'
    ? ok('the same chord signs out')
    : bad('the chord did not sign out', page.url());

  // --------------------------------------------------- and back in, from a field
  // The cursor lands in the username box by itself; the chord must still read.
  await page.click('#identifier');
  await pressChord(chord);
  new URL(page.url()).pathname === '/'
    ? ok('the chord signs in from inside the username field')
    : bad('the chord was swallowed by the username field', page.url());

  (await page.locator('text=/Signed in as|Has entrat|Angemeldet als/').count()) > 0
    ? ok('signing in by chord says who you are now')
    : bad('no toast after signing in by chord');

  // ------------------------------------------ a chord must not eat real typing
  await page.goto(`${BASE}/items`);
  await page.waitForSelector('input');
  await page.locator('input:not([type="checkbox"]):not([type="radio"])').first().click();
  await pressChord(chord);
  new URL(page.url()).pathname === '/items'
    ? ok('a chord typed into a search box is ignored')
    : bad('a chord fired from inside a text field', page.url());

  // ------------------------------------------------------ nobody's chord
  await page.mouse.click(5, 5);
  await pressChord('a+s+d j+k+l');
  (await page.locator('text=/belongs to nobody|no és de ningú|gehört niemandem/').count()) > 0
    ? ok('an unregistered chord says so')
    : bad('an unregistered chord failed silently');
} finally {
  await browser.close();
}

const noise = errors.filter((e) => !/status of 4\d\d/.test(e));
if (noise.length) console.log('\nconsole errors:\n' + noise.join('\n'));
const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed || noise.length ? 1 : 0);
