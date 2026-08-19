// The MVP-1 "done" test, driven through the real UI:
// a stranger logs in and within five minutes can see stock on Home, open and
// deplete an item, create a custom Type of their own and add an item of it,
// move it between locations, and find every action in History.
//
// Expects a freshly seeded database (npm run db:seed on an empty DB) — it
// consumes stock as it goes, which is the point.
//
// Usage: node scripts/acceptance.mjs <baseUrl> <identifier> <password> [outDir]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates lots, opens
// and empties containers, and records activities — running it against the workshop's
// real data leaves test rows behind. Point the API at a scratch copy first:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   DATABASE_PATH=/tmp/scratch.db npm run dev
//
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const identifier = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
const outDir = process.argv[5] ?? '.';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const steps = [];
const step = (name) => { steps.push(name); console.log(`✓ ${name}`); };

// --- 1. Sign in ------------------------------------------------------------
await page.goto(`${baseUrl}/login`);
await page.fill('#identifier', identifier);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts');
step('signed in and Home shows stock metrics');

// --- 2. Open then deplete an item from Home --------------------------------
const openBtn = page.locator('button:has-text("Open")').first();
await openBtn.waitFor();
await openBtn.click();
await page.waitForSelector('text=/→ opened/');
step('opened an item from Home (toast with undo shown)');

const depleteBtn = page.locator('button:has-text("Deplete")').first();
await depleteBtn.waitFor();
await depleteBtn.click();
await page.waitForSelector('text=/→ depleted/');
step('depleted an item from Home');

// --- 3. Create a brand-new custom Type -------------------------------------
const typeKey = `demo${Date.now().toString().slice(-6)}`;
await page.goto(`${baseUrl}/types`);
await page.click('button:has-text("New type")');
await page.waitForSelector('#type-key');
await page.fill('input[name="name.en"]', `Model train ${typeKey}`);
await page.fill('#type-key', typeKey);
await page.fill('#type-prefix', typeKey);
await page.click('button:has-text("Add field")');
await page.fill('input[placeholder="fieldKey"]', 'scale');
await page.fill('input[name="fieldDefinitions.0.label.en"]', 'Scale');
await page.selectOption('select[name="fieldDefinitions.0.kind"]', 'select');
await page.fill('input[placeholder="a, b, c"]', 'H0, N, TT');
await page.waitForSelector('text=Add-item form preview');
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForSelector(`td:has-text("${typeKey}")`);
step(`created a custom Type "${typeKey}" with a select field, no code changes`);

// --- 4. Add an item of that Type, using its custom field --------------------
await page.goto(`${baseUrl}/items`);
await page.click('button:has-text("Add item")');
await page.waitForSelector('#add-type');
// Scope to the drawer: the filter bar behind it has its own location picker.
const drawer = page.locator('div.fixed.inset-0.z-50').last();
await page.selectOption('#add-type', { label: `Model train ${typeKey}` });
await page.waitForSelector('#cf-scale'); // the field the user just invented
await page.selectOption('#cf-scale', 'H0');
await drawer.locator('button.justify-start').first().click(); // the location picker
await page.waitForSelector('text=Flammables cupboard');
await page.click('text=Flammables cupboard');
await page.fill('#add-qty', '1');
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForSelector(`text=/${typeKey}AA001/`);
step('added an item of the new Type, filling its user-defined field');

// --- 5. Move it between locations ------------------------------------------
await page.goto(`${baseUrl}/items`);
await page.fill('input[placeholder*="serial"]', `${typeKey}AA001`);
await page.waitForSelector(`td:has-text("${typeKey}AA001")`);
await page.click(`td:has-text("${typeKey}AA001")`);
await page.waitForSelector('text=Custom fields');
await page.locator('div.fixed.inset-0.z-50').last().locator('button:has-text("Move")').click();
const moveModal = page.locator('div.fixed.inset-0.z-50').last();
await moveModal.locator('button.justify-start').first().click(); // the location picker
await page.click('text=Workbench');
await moveModal.locator('button:has-text("Move")').last().click();
await page.waitForSelector('text=/moved/');
step('moved the item to another location');
await page.screenshot({ path: `${outDir}/acceptance-item.png` });

// --- 6. Find everything in History ------------------------------------------
await page.goto(`${baseUrl}/history`);
await page.fill('input[placeholder*="ID"]', `${typeKey}AA001`);
await page.waitForSelector('tbody span:text-is("moved")');
const actions = await page.$$eval('tbody tr td:nth-child(2) span', (els) =>
  els.map((e) => e.textContent),
);
if (!actions.includes('moved') || !actions.includes('created')) {
  throw new Error(`History missing expected actions, got: ${actions.join(', ')}`);
}
step(`History shows every action for the new item: ${actions.join(', ')}`);
await page.screenshot({ path: `${outDir}/acceptance-history.png` });

// --- 7. Same journey in another language -------------------------------------
await page.click('aside button:has-text("ca")');
await page.waitForSelector('text=Historial');
step('switched to Catalan — UI translated');

console.log(`\n${steps.length} steps passed.`);
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
await browser.close();
if (errors.length) process.exit(1);
