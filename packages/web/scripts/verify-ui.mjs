// Drives everything added in the "grid, filters, sorting, branding, sessions"
// round of changes.
//
// Usage: node scripts/verify-ui.mjs <baseUrl> [outDir]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It registers the first
// admin, creates a concept, a request and a lot, and sets the workshop's logo.
// Point the server at a scratch database, never at the workshop's real one:
//
//   DATABASE_PATH=/tmp/scratch/inventory.db npm run db:seed
//   DATABASE_PATH=/tmp/scratch/inventory.db SERVE_WEB=1 WEB_DIST=./packages/web/dist \
//     PORT=3007 node packages/api/dist/index.js
//   node packages/web/scripts/verify-ui.mjs http://localhost:3007
//
// Exits non-zero if anything failed.

import zlib from 'node:zlib';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://localhost:3007';
const outDir = process.argv[3] ?? '.';
const USER = 'uiadmin';
const PASS = 'ui-check-1234';

const results = [];
const ok = (name, extra = '') => {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  results.push(false);
  console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
};
const check = (condition, name, extra = '') => (condition ? ok(name, extra) : bad(name, extra));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// A 4xx the app handles and shows is the pass condition for some checks below,
// not a defect. 5xx and real JS errors still count.
const handled4xx = /Failed to load resource.*status of 4\d\d/;
page.on('console', (m) => {
  if (m.type() === 'error' && !handled4xx.test(m.text())) errors.push(m.text());
});

/**
 * A solid orange PNG, built here rather than pasted as base64.
 *
 * The whole point of the branding check is "did the colours come out of the
 * image?", and that question is only answerable if the image has a colour this
 * script knows. A copied one-pixel PNG off the internet turned out to be
 * transparent, so the palette fell back to its default and the check passed
 * without testing anything.
 */
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ORANGE = [0xf2, 0x7d, 0x18];
const ORANGE_PNG = solidPng(8, 8, ORANGE);

// ============================================================ 1. signed out
console.log('\n— the noticeboard, with no account —');

await page.goto(`${baseUrl}/`);
await page.waitForSelector('h1');
const publicHeading = await page.locator('h1').first().innerText();
check(/stock|vorrätig|taller/i.test(publicHeading), 'Home opens without signing in', publicHeading);

const showsRealStock = await page.locator('text=Isopropyl alcohol 99%').count();
check(showsRealStock > 0, 'it shows real stock, read from the database');

const hasSignIn = await page.locator('header button:has-text("Sign in")').count();
check(hasSignIn > 0, 'a sign-in button is the way out of it');

await page.screenshot({ path: `${outDir}/ui-public-home.png` });

// Clicking a concept must ask for a session rather than opening anything.
await page.click('button:has-text("Isopropyl alcohol 99%")');
await page.waitForURL('**/login', { timeout: 5000 }).catch(() => {});
check(page.url().endsWith('/login'), 'clicking a card asks you to sign in');

// ============================================================ 2. first admin
console.log('\n— registering, without claiming the computer —');

// Sign in if the account is already there (a second run against the same
// scratch database), register it if not. Registration closes after the first
// user, so a run must not depend on being the first one.
await page.fill('#identifier', USER);
await page.fill('#password', PASS);
await page.click('button[type="submit"]');
const signedIn = await page
  .waitForSelector('text=Active concepts', { timeout: 6000 })
  .then(() => true)
  .catch(() => false);

if (!signedIn) {
  await page.click('text=/First run|Erstmalige|primer/i');
  await page.waitForSelector('#name');
  await page.fill('#name', 'UI Check');
  await page.fill('#identifier', USER);
  await page.fill('#password', PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector('text=Active concepts', { timeout: 15_000 });
  ok('registered the first admin');
} else {
  ok('signed in as the admin');
}

const claimAfterSignIn = await page.evaluate(() => localStorage.getItem('remembered-device'));
check(claimAfterSignIn === null, 'the computer is not claimed by default');

// ============================================================== 3. Home grid
console.log('\n— Home —');

const gridColumns = await page
  .locator('[data-tour="concept-cards"]')
  .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
check(gridColumns >= 2, 'concept cards lay out as a grid on a wide window', `${gridColumns} columns`);

// Narrow enough that only one 19rem column can fit — the phone case, which is
// the old row layout and must still be what you get.
await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(400);
const narrowColumns = await page
  .locator('[data-tour="concept-cards"]')
  .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
check(narrowColumns === 1, 'and rearranges to a single column when the window narrows');
await page.setViewportSize({ width: 1440, height: 950 });
await page.waitForTimeout(300);

// Drag the separator, reload, and see the width survive.
const handle = page.locator('[role="separator"]').first();
const before = await page.locator('[data-tour="location-tree"]').evaluate((el) => el.clientWidth);
const box = await handle.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 130, box.y + 120, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await page.locator('[data-tour="location-tree"]').evaluate((el) => el.clientWidth);
check(after > before + 60, 'the location panel can be dragged wider', `${before}px → ${after}px`);

await page.reload();
await page.waitForSelector('[data-tour="location-tree"]');
const reloaded = await page.locator('[data-tour="location-tree"]').evaluate((el) => el.clientWidth);
check(Math.abs(reloaded - after) < 8, 'and it is still that wide after a reload', `${reloaded}px`);
await page.screenshot({ path: `${outDir}/ui-home-grid.png` });

// ============================================================== 4. Items
console.log('\n— Items —');

await page.goto(`${baseUrl}/items`);
await page.waitForSelector('[data-tour="items-table"]');

// Typing into a filter narrows the list instead of making you scroll it.
const conceptBox = page.locator('[data-tour="items-filters"] input[role="combobox"]').nth(1);
await conceptBox.click();
await conceptBox.fill('isoprop');
await page.waitForTimeout(150);
const optionCount = await page.locator('li [role="option"]').count();
check(optionCount === 1, 'typing in a filter narrows the options', `${optionCount} left`);

// Accents must not be the thing standing between you and your own data.
await conceptBox.fill('wood glue');
await page.waitForTimeout(150);
check((await page.locator('li [role="option"]').count()) >= 1, 'search ignores accents and case');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

const variantBox = page.locator('[data-tour="items-filters"] input[role="combobox"]').nth(2);
await variantBox.click();
await page.waitForTimeout(200);
const variantOptions = await page.locator('li [role="option"]').count();
check(variantOptions >= 1, 'the variant filter only offers variants of the chosen concept', `${variantOptions}`);
await page.keyboard.press('Escape');

await page.click('button:has-text("Clear filters")').catch(() => {});
await page.goto(`${baseUrl}/items`);
await page.waitForSelector('[data-tour="items-table"]');

// Sorting has to reorder the whole table, and reverse on a second click.
const idsNow = () => page.locator('tbody tr td:nth-child(2)').allInnerTexts();
await page.click('th:has-text("ID") button');
await page.waitForTimeout(500);
const ascending = await idsNow();
await page.click('th:has-text("ID") button');
await page.waitForTimeout(500);
const descending = await idsNow();
check(
  ascending.length > 1 && JSON.stringify(ascending) === JSON.stringify([...descending].reverse()),
  'clicking a header sorts, clicking again reverses it',
);

// A third click clears the sort. Checked on the header rather than by
// comparing rows: the seed writes every item in one transaction, so the
// default "newest first" order and ID order are legitimately the same list,
// and comparing them proves nothing either way.
await page.click('th:has-text("ID") button');
await page.waitForTimeout(500);
const stillSorted = await page.locator('th:has-text("ID")').getAttribute('aria-sort');
check(stillSorted === 'none', 'a third click returns to the table\'s own order', stillSorted ?? '');

// A numeric column must sort as numbers, not as text.
await page.click('th:has-text("Remaining") button');
await page.waitForTimeout(500);
const remaining = (await page.locator('tbody tr td:nth-child(8)').allInnerTexts())
  .map((text) => Number.parseFloat(text))
  .filter((n) => Number.isFinite(n));
check(
  remaining.every((value, i) => i === 0 || remaining[i - 1] <= value),
  'quantities sort as numbers',
  remaining.slice(0, 5).join(', '),
);
await page.screenshot({ path: `${outDir}/ui-items-sorted.png` });

// ============================================================== 5. Variants
console.log('\n— Variants —');

await page.goto(`${baseUrl}/variants`);
await page.waitForSelector('table');
const variantFilters = await page.locator('input[role="combobox"]').count();
check(variantFilters >= 2, 'Variants has type and concept filters');

await page.click('th:has-text("Brand") button');
await page.waitForTimeout(500);
const brands = (await page.locator('tbody tr td:nth-child(3)').allInnerTexts()).filter((b) => b !== '—');
check(
  brands.every((value, i) => i === 0 || brands[i - 1].toLowerCase() <= value.toLowerCase()),
  'and sorts alphabetically by a column',
  brands.slice(0, 4).join(', '),
);

// ================================================= 6. request → lot → variant
console.log('\n— a request becoming a lot line —');

// A concept with no products under it at all: the case that used to dead-end.
await page.goto(`${baseUrl}/concepts`);
await page.waitForSelector('h1');
await page.click('button:has-text("New concept")');
await page.waitForSelector('input[name="name.en"]');
await page.fill('input[name="name.en"]', 'Cyanoacrylate glue');
await page.fill('input[name="unit"]', 'mL');
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForTimeout(800);
ok('created a concept with no products under it');

await page.goto(`${baseUrl}/requests`);
await page.waitForSelector('h1');
await page.click('button:has-text("Request something")');
await page.waitForSelector('#req-concept');
await page.fill('#req-concept', 'Cyanoacrylate');
await page.waitForTimeout(250);
await page.locator('[role="option"]').first().click();
await page.locator('#req-qty').fill('500');
await page.click('[role="dialog"] button:has-text("Save")');
await page.waitForTimeout(900);
check(
  (await page.locator('td:has-text("Cyanoacrylate glue"), p:has-text("Cyanoacrylate glue")').count()) > 0,
  'asked for 500 mL of it, at concept level',
);

await page.goto(`${baseUrl}/lots`);
await page.waitForSelector('h1');
await page.click('button:has-text("New lot")');
await page.waitForSelector('[role="dialog"]');
// The seed already has a supplier, so the picker shows chips rather than a
// text box — taking the first one is the ordinary path.
await page.locator('[role="dialog"] button.rounded-full').first().click();
await page.click('[role="dialog"] button:has-text("Save")');
await page.waitForSelector('[data-ui="drawer"]', { timeout: 8000 });

// Pick the request out of the queue inside the draft lot.
await page.locator('label:has-text("Cyanoacrylate glue") input[type="checkbox"]').first().click();
await page.click('button:has-text("Order the")');
await page.waitForSelector('[data-ui="modal"]:has-text("Add line")', { timeout: 8000 });
// The concept arrives from the seeded requests one render after the modal
// opens, so its copy is not on screen the instant the dialog is.
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/ui-lot-line.png` });

const noProducts = await page.locator('text=/no products yet|cap producte|kein Produkt/i').count();
check(noProducts > 0, 'the form says the concept has no products yet, instead of an empty list');

await page.click('button:has-text("New product")');
await page.waitForSelector('#line-new-name');
await page.fill('#line-new-name', 'Bramble CA glue, 20 g');
await page.fill('#line-new-brand', 'Bramble');
await page.fill('#line-new-pack', '100');
await page.fill('#line-new-unit', 'mL');
const typeSelect = page.locator('#line-new-type');
if (await typeSelect.count()) await typeSelect.selectOption({ index: 1 });
await page.fill('#line-qty', '5');
await page.fill('#line-price', '42.00');
await page.click('[data-ui="modal"] button:has-text("Add")');
await page.waitForTimeout(1200);
check(
  (await page.locator('text=Bramble CA glue, 20 g').count()) > 0,
  'a product named on the spot becomes the ordered line',
);

// And it is a real Variant afterwards, not a string on the line.
await page.goto(`${baseUrl}/variants`);
await page.waitForSelector('table');
await page.fill('input[placeholder*="brand" i], input[placeholder*="marca" i], input[placeholder*="Marke" i]', 'Bramble CA');
await page.waitForTimeout(700);
check(
  (await page.locator('td:has-text("Bramble CA")').count()) > 0,
  'and it exists as a variant, filed under the concept',
);

// ============================================================== 7. branding
console.log('\n— the workshop\'s own look —');

await page.goto(`${baseUrl}/`);
await page.waitForSelector('[data-tour="nav"]');
await page.click('button[title*="Theme"], button[title*="Aparen"], button[title*="Farb"]');
await page.waitForSelector('[role="dialog"]');
await page.setInputFiles('input[type="file"]', {
  name: 'logo.png',
  mimeType: 'image/png',
  buffer: ORANGE_PNG,
});
await page.waitForTimeout(800);

const schemeButtons = await page.locator('[role="dialog"] button:has-text("Calm"), [role="dialog"] button:has-text("Bright"), [role="dialog"] button:has-text("Deep")').count();
check(schemeButtons === 3, 'a logo yields three colour schemes to choose from', `${schemeButtons}`);

await page.click('[role="dialog"] button:has-text("Bright")');
await page.waitForTimeout(300);
const primary = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--color-primary-base').trim(),
);
check(/^#[0-9a-f]{6}$/i.test(primary), 'picking one repaints the app', primary);

// Orange in, orange out: the scheme re-lights the hue but must not invent one.
const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1;
  const d = max - min;
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const hue = hueOf(primary);
check(Math.abs(hue - hueOf('#f27d18')) < 25, 'and the colours came from the logo', `hue ${Math.round(hue)}°`);

await page.fill('#site-name', 'Workshop UI Check');
await page.click('[role="dialog"] button:has-text("Save for everybody")');
await page.waitForTimeout(1200);
check((await page.locator('[data-tour="nav"]').count()) > 0, 'saved the workshop branding');
await page.screenshot({ path: `${outDir}/ui-branding.png` });

// The point of "for the whole workshop" is a computer that has never seen it.
const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const freshPage = await fresh.newPage();
await freshPage.goto(`${baseUrl}/`);
await freshPage.waitForSelector('h1');
const freshLogo = await freshPage.locator('header img').count();
const freshPrimary = await freshPage.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--color-primary-base').trim(),
);
check(freshLogo > 0, 'a computer that has never opened the menu shows the logo');
check(
  freshPrimary.toLowerCase() === primary.toLowerCase(),
  'and wears the workshop colours',
  `${freshPrimary} = ${primary}`,
);
await fresh.close();

// ========================================================= 8. remembering
console.log('\n— remembering a computer —');

await page.click('button[title*="Remember"], button[title*="Recorda"], button[title*="merken"]');
await page.waitForSelector('#claim-password');
await page.fill('#claim-password', 'definitely-not-the-password');
await page.click('[role="dialog"] button:has-text("Remember this computer")');
await page.waitForTimeout(900);
check(
  (await page.locator('text=/not your password|no és la teva|nicht dein Passwort/i').count()) > 0,
  'the wrong password does not claim the computer',
);

await page.fill('#claim-password', PASS);
await page.click('[role="dialog"] button:has-text("Remember this computer")');
await page.waitForTimeout(1200);
const claim = await page.evaluate(() => localStorage.getItem('remembered-device'));
check(claim !== null && JSON.parse(claim).username === USER, 'the right password claims it', claim ?? '');

// A claimed computer must keep its session with the browser shut, which is
// exactly what a cookie with an expiry date does and a session cookie does not.
const cookies = await context.cookies();
const sessionCookie = cookies.find((c) => c.name.includes('session_token'));
check(
  sessionCookie !== undefined && sessionCookie.expires > 0,
  'and its session cookie now survives closing the browser',
  sessionCookie ? new Date(sessionCookie.expires * 1000).toISOString().slice(0, 10) : 'none',
);

// =========================================================== 8b. going idle
console.log('\n— twenty minutes of silence —');

// A fake clock, because the real test takes twenty minutes. Everything the
// timer reads — Date.now(), setInterval — comes from here, so fast-forwarding
// is the same as walking away from the keyboard.
const idlePage = await context.newPage();
await idlePage.clock.install();
await idlePage.goto(`${baseUrl}/`);
await idlePage.waitForSelector('[data-tour="nav"]');

// This computer is claimed by now, so nothing should happen at all.
await idlePage.clock.fastForward('25:00');
await idlePage.waitForTimeout(500);
check(!idlePage.url().includes('/login'), 'a claimed computer is never signed out for idling');

await idlePage.close();

// Now a shared computer: same fake clock, no claim. Cleared with an init
// script rather than by reloading, because the fake clock is installed per
// page load and a reload would put the real one back.
const sharedPage = await context.newPage();
await sharedPage.clock.install();
await sharedPage.addInitScript(() => localStorage.removeItem('remembered-device'));
await sharedPage.goto(`${baseUrl}/`);
await sharedPage.waitForSelector('[data-tour="nav"]');

await sharedPage.clock.fastForward('19:10');
await sharedPage.waitForTimeout(500);
const warned = await sharedPage.locator('text=/Still there|Encara hi ets|Noch da/i').count();
check(warned > 0, 'a shared one warns a minute before it gives up');

await sharedPage.clock.fastForward('01:10');
await sharedPage.waitForURL('**/login**', { timeout: 10_000 }).catch(() => {});
check(sharedPage.url().includes('/login'), 'and then signs out');
check(sharedPage.url().includes('idle=1'), 'saying why, on the sign-in screen', sharedPage.url());
await sharedPage.close();

// Signing out cleared the cookie for the whole context, so the admin has to
// come back before the last section can reach an admin-only page.
await page.goto(`${baseUrl}/login`);
await page.fill('#identifier', USER);
await page.fill('#password', PASS);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts', { timeout: 15_000 });


// ========================================================= 9. sign out all
console.log('\n— signing everyone out —');

page.on('dialog', (dialog) => dialog.accept());
await page.goto(`${baseUrl}/users`);
await page.waitForSelector('h1');
await page.click('button:has-text("Sign everyone out")');
await page.waitForURL('**/login', { timeout: 10_000 }).catch(() => {});
check(page.url().includes('/login'), 'it ends the admin\'s own session too');

await page.goto(`${baseUrl}/items`);
await page.waitForTimeout(600);
check(page.url().includes('/login'), 'and a protected page is closed again');

// ================================================================== results
console.log('');
check(errors.length === 0, 'no console errors anywhere', errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
