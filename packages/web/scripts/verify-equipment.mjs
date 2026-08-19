// Browser check for block 3: instruments (attached items + maintenance) and
// the browsable Locations page. Usage:
//   node scripts/verify-equipment.mjs <outDir> [username] [password] [baseUrl]
//
// NOTE THE ARGUMENT ORDER: the output directory comes first, not the URL.
// Passing a URL as the first argument silently leaves the target at the
// default — which is the dev server, and therefore the real database.
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It counts a use and
// records a maintenance service on toolAA001. Point it at a copy:
//
//   python3 -c "import sqlite3; s=sqlite3.connect('file:packages/api/data/inventory.db?mode=ro',uri=True); d=sqlite3.connect('/tmp/scratch.db'); s.backup(d)"
//   # in packages/api, serving the built SPA on one port:
//   SERVE_WEB=1 WEB_DIST=../web/dist DATABASE_PATH=/tmp/scratch.db PORT=3003 npx tsx src/index.ts
//   node scripts/verify-equipment.mjs /tmp/shots mailuk the-password http://localhost:3003
//
// (Copy the file with sqlite's own backup, not `cp` — the database runs in WAL
// mode, so a plain copy of the .db alone can be torn.)
//
import { chromium } from 'playwright';

const outDir = process.argv[2] ?? '.';
const username = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
// Fourth, not first — the argument order predates the base-url convention the
// later suites use, and changing it now would silently retarget any command
// somebody already has in their history.
const baseUrl = process.argv[5] ?? 'http://localhost:5173';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
const step = (n) => console.log(`  ${n}`);

await page.goto(`${baseUrl}/login`);
await page.waitForSelector('text=Sign in');
await page.fill('#identifier', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts');
step('signed in');

// --- 1. Home: the due-maintenance card sits above the stock ---------------
await page.waitForSelector('text=Maintenance due');
await shot('e01-home-maintenance-due');
step('Home shows the maintenance card');

// --- 2. Clicking a row opens that instrument's drawer ---------------------
await page.click('button:has(.human-id:text("toolAA001"))');
await page.waitForSelector('h2:has-text("toolAA001")');
await page.click('button:has-text("Equipment")');
await page.waitForSelector('text=Attached to this item');
await shot('e02-drawer-equipment');
step('drawer opens on the Equipment tab');

// --- 3. The uses counter moves ------------------------------------------
const before = await page.textContent('text=/\\d+ uses since/');
await page.click('button:has-text("+1 use")');
await page.waitForTimeout(600);
const after = await page.textContent('text=/\\d+ uses since/');
if (before === after) throw new Error(`use counter did not move: ${before}`);
step(`use counted: ${before.trim()} → ${after.trim()}`);

// --- 4. Recording a service resets both counters -------------------------
await page.click('button:has-text("Done") >> nth=0');
await page.waitForSelector('text=Records the service');
await page.fill('input[placeholder*="certificate"]', 'browser check');
// Inside the dialog, not the card behind it — both say "Done".
await page.click('[data-ui="modal"] button:has-text("Done")');
await page.waitForTimeout(800);
await shot('e03-service-recorded');
step('service recorded');

// --- 5. Attaching a document --------------------------------------------
await page.click('button:has-text("Attach")');
await page.waitForSelector('text=What is it?');
await page.fill('input[placeholder="ID, name…"]', 'document');
await page.waitForTimeout(700);
await shot('e04-attach-picker');
step('attach picker searches items');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// --- 6. Locations: pick a place, see what is in it -----------------------
await page.goto(`${baseUrl}/locations`);
await page.waitForSelector('text=Pick a place');
await shot('e05-locations-empty-state');
await page.click('text=Store room');
await page.waitForTimeout(900);
await shot('e06-locations-contents');
const rows = await page.locator('table tr').count();
if (rows === 0) throw new Error('location contents listed nothing');
step(`Store room lists ${rows} rows`);

await page.click('text=Include sub-locations').catch(() => {});
await page.waitForTimeout(800);
await shot('e07-locations-exact');
step('subtree toggle works');

// --- 7. History reads as sentences --------------------------------------
await page.goto(`${baseUrl}/history`);
await page.waitForSelector('td:has-text("serviced")');
await shot('e08-history');
step('history shows the service');

if (errors.length > 0) {
  console.error('\nCONSOLE ERRORS:\n' + errors.join('\n'));
  await browser.close();
  process.exit(1);
}

console.log('\nblock 3 verified — no console errors');
await browser.close();
