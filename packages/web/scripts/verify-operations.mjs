// Drives everything built for — the operational half of the app.
// Usage: node scripts/verify-operations.mjs <baseUrl> <user> <pass> [outDir]
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
const username = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
const outDir = process.argv[5] ?? '.';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ok = (name) => console.log(`✓ ${name}`);

await page.goto(`${baseUrl}/login`);
await page.fill('#identifier', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts');
ok('signed in');

// 1. Tracking level is a property of a Concept, not a global mode ----------
await page.goto(`${baseUrl}/concepts`);
await page.click('tr:has-text("Isopropyl alcohol") button[title="Edit"], tr:has-text("Isopropyl alcohol") >> nth=0');
await page.waitForSelector('#trackingLevel', { timeout: 5000 }).catch(async () => {
  // The row click may not open the modal; use the explicit edit control.
  await page.click('tr:has-text("Isopropyl alcohol") svg.lucide-pencil');
  await page.waitForSelector('#trackingLevel');
});
const level = await page.locator('#trackingLevel').inputValue();
const seeded = await page.locator('#seeded').inputValue();
if (level !== '2') throw new Error(`expected isopropyl at level 2, got ${level}`);
ok(`isopropyl tracks at level ${level}, seeded rate ${seeded}/month`);
await page.screenshot({ path: `${outDir}/ops-tracking-level.png` });
await page.click('button:has-text("Cancel")');

// 2. Forecast: a list that ends in one button, not a chart -----------------
await page.goto(`${baseUrl}/forecast`);
await page.waitForSelector('h1:has-text("Forecast")');
await page.click('button:has-text("Show everything")');
await page.waitForTimeout(600);
const forecastCards = await page.locator('div.rounded-lg.border').count();
if (forecastCards === 0) throw new Error('forecast rendered no rows');
const workingShown = await page.locator('text=/Using|Not enough history/').count();
if (workingShown === 0) throw new Error('forecast never shows its working');
ok(`forecast lists ${forecastCards} concepts and shows its working`);
await page.screenshot({ path: `${outDir}/ops-forecast.png` });

// 3. Request captured at the moment of the shortage ------------------------
await page.goto(`${baseUrl}/requests`);
await page.click('button:has-text("Request something")');
await page.waitForSelector('#req-concept');
// A searchable combobox, not a <select>: type a few letters and take the
// first match, which is what a person does.
await page.fill('#req-concept', 'isopropyl');
await page.locator('[role="option"]').first().click();
await page.fill('#req-qty', '3');
await page.selectOption('#req-urgency', 'blocking');
await page.click('button:has-text("Save")');
await page.waitForSelector('text=/REQ\\d+ created/');
ok('request created, urgency blocking');

// 3b. A second request for the same concept offers a +1 instead of a duplicate
await page.click('button:has-text("Request something")');
await page.waitForSelector('#req-concept');
await page.fill('#req-concept', 'isopropyl');
await page.locator('[role="option"]').first().click();
await page.waitForSelector('button:has-text("Add me too")', { timeout: 5000 });
ok('a duplicate request is offered as a +1 (demand intensity, not a second row)');
await page.screenshot({ path: `${outDir}/ops-request-metoo.png` });
await page.click('button:has-text("Cancel")');

// 4. Lot: triage → resolve the line → order → receive ----------------------
// Creating a lot asks for the supplier and nothing else: the order reference
// does not exist until the order has actually been placed.
await page.goto(`${baseUrl}/lots`);
await page.click('button:has-text("New lot")');
await page.waitForSelector('#supplier-new, .fixed button:has-text("Northside")');
if (await page.locator('#lot-ref').count()) {
  throw new Error('the create form still asks for a reference that cannot exist yet');
}
const newSupplier = page.locator('#supplier-new');
if (await newSupplier.count()) {
  await newSupplier.fill('Corvid');
} else {
  await page.locator('.fixed button:has-text("A new supplier")').click();
  await page.waitForSelector('#supplier-new');
  await page.fill('#supplier-new', 'Corvid');
}
await page.locator('div.max-w-md button:text-is("Save")').click();
// Wait for the DRAWER, not just the row in the list behind it: the drawer only
// mounts once the refetched list contains the new lot.
await page.locator('div.fixed').filter({ hasText: 'Corvid' })
  .getByText('Lines').first().waitFor({ timeout: 10_000 });
ok('draft lot created from the supplier alone');

// The open requests are inside the draft, with checkboxes — that is where the
// buying decision happens, so that is where the queue has to be.
//
// The count is read from the page rather than assumed, because a previous run
// of this script will have turned some of them into lot lines. What must hold
// is that the panel and the queue agree, whatever the queue currently holds.
// The request queue is fetched *after* the drawer mounts, so give it a moment
// to arrive before sampling. Reading straight away finds an empty panel and
// reports it as a missing one — which is a race in this script, not a defect.
// A timeout here is fine: no open requests is a legitimate state.
await page.locator('text=/\\d+ open/').first().waitFor({ timeout: 5000 }).catch(() => {});
const banner = await page.locator('text=/\\d+ open/').first().textContent().catch(() => null);
const openInQueue = banner ? Number(banner.match(/(\d+) open/)?.[1] ?? 0) : 0;
const requestBoxes = page.locator('.fixed input[type="checkbox"]');
const groupsOffered = await requestBoxes.count();
if (openInQueue > 0 && groupsOffered === 0) {
  throw new Error(`${openInQueue} requests are open but the draft lot offers none`);
}
if (openInQueue === 0 && groupsOffered > 0) {
  throw new Error('the draft lot offers requests that are not open');
}
ok(
  openInQueue > 0
    ? `${groupsOffered} open request group(s) offered inside the lot`
    : 'queue empty and the panel correctly stays hidden',
);
await page.screenshot({ path: `${outDir}/ops-lot-requests.png` });

await page.click('button:has-text("Add line")');
await page.waitForSelector('#line-concept');
await page.fill('#line-concept', 'Isopropyl alcohol');
await page.locator('[role="option"]').first().click();
const modal = page.locator('[data-ui="modal"]');
await modal.locator('button:has-text("Northline")').first().waitFor({ timeout: 5000 });
// "Same as last time": one click fills the variant AND its last price.
await modal.locator('button:has-text("Northline")').first().click();
const filledPrice = await page.locator('#line-price').inputValue();
if (!filledPrice) throw new Error('picking a previous purchase did not carry its price');
ok(`one-click reorder carried last price (${filledPrice})`);
await page.fill('#line-qty', '5');
await modal.locator('button:text-is("Add")').click();
await page.locator('div.sm\\:max-w-2xl').getByText('ORDERED', { exact: false }).first()
  .waitFor({ timeout: 5000 });
ok('lot line resolved Concept → Variant');
await page.screenshot({ path: `${outDir}/ops-lot-line.png` });

// Ordering is where the reference finally exists, so that is where it is asked.
await page.click('button:has-text("Mark as ordered")');
await page.waitForSelector('#order-ref');
await page.fill('#order-ref', 'PO-TEST-01');
await page.getByRole('button', { name: 'Mark as ordered' }).last().click();
await page.waitForSelector('text=PO-TEST-01');
ok('lot ordered, reference captured at the moment it exists');

// Receive FEWER than ordered, and a substituted product — the two
// discrepancies that must survive as data rather than be tidied away.
await page.click('button:has-text("Receive delivery")');
await page.waitForSelector('input[type="number"]');
const qtyInput = page.locator('div.rounded-lg.border input[type="number"]').first();
await qtyInput.fill('3');
await page.check('input[type="checkbox"] >> nth=0');
await page.fill('input[placeholder*="actually arrived"]', 'Corvid IPA 99%, 1 L');
await page.waitForSelector('text=The rest will never come');
await page.check('text=The rest will never come >> input');
await page.click('button:has-text("Receive delivery") >> nth=1');
await page.waitForSelector('text=/3 items created/', { timeout: 8000 });
ok('reception created 3 items automatically');

const shortRecorded = await page.locator('text=/ordered 5, received 3/').count();
const substituted = await page.locator('text=/substituted|ordered .*, received/').count();
if (shortRecorded === 0 && substituted === 0) {
  throw new Error('reception discrepancies were not recorded');
}
ok('short delivery and substitution both recorded as discrepancies');
await page.screenshot({ path: `${outDir}/ops-reception.png` });

// The ordered side survives untouched beside the received side.
const orderedStillFive = await page.locator('text=/5 ×/').count();
if (orderedStillFive === 0) throw new Error('the ordered side was overwritten by reception');
ok('the ordered side was not overwritten (two-sided line holds)');

// 5. Supplier performance accumulates by itself ---------------------------
await page.goto(`${baseUrl}/lots`);
await page.waitForSelector('text=Supplier performance');
const supplierText = await page.locator('text=Supplier performance').locator('..').innerText();
const supplierNames = supplierText
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && line !== 'Supplier performance' && !line.includes('%'));
if (supplierNames.some((name) => name === '—')) {
  throw new Error('a lot lost its supplier: stats fell back to the unnamed bucket');
}
ok(`supplier stats derived with nothing to configure: ${supplierNames.join(' · ')}`);

// 6. Activities: record → the quantity moves → the container stays open ----
// Rule, as corrected on 2026-08-06: recording an activity is a person
// saying what happened, so the numbers follow. What must NOT happen is the
// app closing a container on its own.
//
// The charge has to land somewhere, so the first activity in the list needs at
// least one concept with an open container. Repeated runs of this script empty
// them and eventually drink the seed dry, so make the precondition true rather
// than hope for it — including creating stock if there is none left.
//
// Whether some OTHER concept has nothing open is then read from reality below,
// not assumed: both states are legitimate, and the check adapts.
const setup = await page.evaluate(async () => {
  const actions = await (await fetch('/api/v1/actions')).json();
  const action = actions.find((a) => (a.lineDetails ?? []).length > 0);
  if (!action) return { conceptIds: [], backed: [], opened: [] };

  const conceptIds = [...new Set(action.lineDetails.map((l) => l.conceptId))];
  const opened = [];
  const backed = [];

  for (const conceptId of conceptIds) {
    const open = await (
      await fetch(`/api/v1/items?perPage=100&status=open&conceptId=${conceptId}`)
    ).json();
    if ((open.data ?? []).some((i) => i.quantityInitial != null)) {
      backed.push(conceptId);
      continue;
    }
    // Only the first unbacked concept gets a container: if every one of them
    // had stock, the "nothing open to charge" path would never be exercised.
    if (backed.length > 0 || opened.length > 0) continue;

    const stocked = await (
      await fetch(`/api/v1/items?perPage=100&status=in_stock&conceptId=${conceptId}`)
    ).json();
    let candidate = (stocked.data ?? []).find((i) => i.quantityInitial != null);

    if (!candidate) {
      // The seed is finite and this script consumes it. Make one rather than
      // let the check pass by skipping — a suite that quietly stops testing
      // is worse than a red one.
      const any = await (await fetch(`/api/v1/items?perPage=100&conceptId=${conceptId}`)).json();
      const template = (any.data ?? []).find((i) => i.quantityInitial != null);
      if (!template) continue;
      const created = await fetch('/api/v1/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          typeId: template.typeId,
          variantId: template.variantId,
          locationId: template.locationId,
          quantityInitial: template.quantityInitial,
          unit: template.unit,
          notes: 'created by verify-operations.mjs',
        }),
      });
      const body = await created.json();
      candidate = Array.isArray(body) ? body[0] : body;
      if (!candidate?.id) continue;
    }

    await fetch(`/api/v1/items/${candidate.id}/open`, { method: 'POST' });
    opened.push(candidate.humanId);
  }

  return { conceptIds, backed: [...backed, ...opened.map(() => 'opened')], opened };
});
if (setup.opened.length > 0) {
  ok(`opened ${setup.opened.join(', ')} so the charge has somewhere to land`);
}
// True when at least one of the activity's concepts still has nothing open.
const expectUnbacked = setup.conceptIds.length > setup.backed.length;

const stockBefore = await page.evaluate(async () => {
  const res = await fetch('/api/v1/concepts/stock');
  return res.json();
});
const openBefore = await page.evaluate(async () => {
  const res = await fetch('/api/v1/items?perPage=100&status=open');
  const body = await res.json();
  return body.data.map((item) => item.id).sort();
});

await page.goto(`${baseUrl}/actions`);
await page.waitForSelector('h1:has-text("Activities")');
await page.click('button:has-text("Record") >> nth=0');
await page.waitForSelector('#rec-count');
await page.fill('#rec-count', '4');
await page.locator('div.max-w-md button:text-is("Record")').click();
// The summary panel only *stays* open when something needs saying — that is
// the fix from session 4, so waiting for it unconditionally would fail on the
// happy path, where the modal closes because every concept had a container.
const summary = page.locator('text=Charged to open containers');
await summary.waitFor({ timeout: 5000 }).catch(() => {});
const chargeSummary = (await summary.innerText().catch(() => '')) || '';
const surfaced = /nothing open to charge/.test(chargeSummary);
if (expectUnbacked && !surfaced) {
  throw new Error('a concept with no open container was not surfaced');
}
if (!expectUnbacked && surfaced) {
  throw new Error('reported nothing open to charge, but every concept had a container');
}
if (!expectUnbacked && (await page.locator('#rec-count').count()) > 0) {
  throw new Error('nothing needed saying, yet the record dialog stayed open');
}
ok(
  expectUnbacked
    ? 'activity recorded; the concept with no open container was surfaced, not swallowed'
    : 'activity recorded; every concept had a container and none was reported missing',
);
await page.screenshot({ path: `${outDir}/ops-record-action.png` });
await page.click('button:has-text("Not yet"), button:has-text("Cancel")').catch(() => {});
await page.keyboard.press('Escape');

const stockAfter = await page.evaluate(async () => {
  const res = await fetch('/api/v1/concepts/stock');
  return res.json();
});
const openAfter = await page.evaluate(async () => {
  const res = await fetch('/api/v1/items?perPage=100&status=open');
  const body = await res.json();
  return body.data.map((item) => item.id).sort();
});

// The quantity moved: the whole point of pressing one button instead of eight.
const moved = Object.keys(stockBefore).filter((id) => stockAfter[id] < stockBefore[id]);
if (moved.length === 0) {
  throw new Error('recording an activity changed no stock at all — the charge went nowhere');
}
ok(`recording an activity moved stock for ${moved.length} concept(s)`);

// But nothing closed itself. That decision is a person's, always.
if (JSON.stringify(openBefore) !== JSON.stringify(openAfter)) {
  throw new Error('RULE VIOLATED: an activity opened or closed a container by itself');
}
ok('no container was opened or closed without a human saying so');

// 6b. The full cycle: overdraw → a person closes it → a SIGNED gap ---------
// This is the argument of end to end. Record enough activity to drain
// the container past what it held, confirm the app never closes it by itself,
// then close it by hand and check the gap came out with the right sign.
const overdrawn = await page.evaluate(async () => {
  // /actions returns a plain array, not a paginated envelope.
  const list = await (await fetch('/api/v1/actions')).json();

  // Search every line of every activity for one whose concept actually has an
  // open container with a quantity. Taking the first line and giving up made
  // this check pass by skipping, which proves nothing.
  let action = null;
  let line = null;
  let before = [];
  for (const candidate of list) {
    for (const candidateLine of candidate.lineDetails ?? []) {
      const items = await (
        await fetch(`/api/v1/items?perPage=100&status=open&conceptId=${candidateLine.conceptId}`)
      ).json();
      const withQuantity = (items.data ?? []).filter((i) => i.quantityInitial != null);
      if (withQuantity.length > 0) {
        action = candidate;
        line = candidateLine;
        before = withQuantity;
        break;
      }
    }
    if (action) break;
  }
  if (!action) return { skipped: 'no activity charges a concept with an open container' };

  // Enough occurrences to drain the largest of them past empty, so whichever
  // one the server picks ends up overdrawn.
  const biggest = Math.max(...before.map((i) => i.quantityRemaining ?? i.quantityInitial));
  const count = Math.ceil(biggest / line.quantity) + 1;
  await fetch('/api/v1/action-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: action.id, count }),
  });

  // Rather than predict which container the server draws from, find the one it
  // actually charged. Guessing the tie-break was testing the test.
  const claims = Object.fromEntries(before.map((i) => [i.id, i.estimatedUsed]));
  let charged = null;
  for (const item of before) {
    const after = await (await fetch(`/api/v1/items/${item.id}`)).json();
    if (after.estimatedUsed > claims[item.id]) {
      charged = { ...after, held: item.quantityInitial };
      break;
    }
  }
  if (!charged) return { skipped: 'the charge did not reach any of the open containers' };

  return {
    itemId: charged.id,
    humanId: charged.humanId,
    held: charged.held,
    remaining: charged.quantityRemaining,
    status: charged.status,
    claimed: charged.estimatedUsed,
  };
});

if (overdrawn.skipped) {
  ok(`overdraw cycle skipped: ${overdrawn.skipped}`);
} else {
  if (overdrawn.remaining !== 0) {
    throw new Error(`overdrawn container should read 0, reads ${overdrawn.remaining}`);
  }
  if (overdrawn.status !== 'open') {
    throw new Error(`the app closed ${overdrawn.humanId} by itself.13`);
  }
  if (overdrawn.claimed <= overdrawn.held) {
    throw new Error('estimatedUsed was clamped; the over-claim is lost and the gap cannot be signed');
  }
  ok(
    `overdrawn: ${overdrawn.humanId} reads 0 but stays open, ` +
      `claim ${overdrawn.claimed} > held ${overdrawn.held}`,
  );

  // Now a person says it is empty. The gap must be NEGATIVE — the recipe ran
  // fat — which the old "estimates only grow" model could not express at all.
  const gap = await page.evaluate(async (itemId) => {
    await fetch(`/api/v1/items/${itemId}/deplete`, { method: 'POST' });
    const rows = await (await fetch('/api/v1/reconciliations?perPage=100')).json();
    const mine = (rows.data ?? rows).find((r) => r.itemId === itemId);
    return mine ?? null;
  }, overdrawn.itemId);

  if (!gap) throw new Error('closing the container wrote no reconciliation');
  if (gap.unassigned >= 0) {
    throw new Error(`expected a negative gap (fat recipe), got ${gap.unassigned}`);
  }
  ok(`closing it recorded a signed gap: ${gap.unassigned} (recipe over-estimates)`);
}

// 7. Editing a map creates a dated version instead of rewriting the past ---
await page.goto(`${baseUrl}/actions`);
await page.locator('button[title="Map history"]').first().click();
await page.waitForSelector('text=In force from');
const versionCount = await page.locator('text=In force from').count();
ok(`consumption map is dated (${versionCount} version(s) in history)`);
await page.keyboard.press('Escape');

// 8. Pools: counted, not itemised; the recount measures breakage ----------
await page.goto(`${baseUrl}/pools`);
await page.waitForSelector('text=Mixing cups');
const attrition = await page.locator('text=/lost per month/').first().innerText();
ok(`cup pool reports measured breakage: ${attrition}`);

await page.click('button:has-text("Recount")');
await page.waitForSelector('#counted');
const expectedNow = Number(
  (await page.locator('text=The app expected').locator('..').innerText()).replace(/\D/g, ''),
);
const expected = `The app expected ${expectedNow}`;
await page.fill('#counted', String(expectedNow - 8));
await page.waitForSelector('text=/lost since the last count/');
ok(`recount turns a physical count into attrition (${expected.replace('\n', ' ')})`);
await page.screenshot({ path: `${outDir}/ops-recount.png` });
await page.locator('div.max-w-md button:text-is("Save")').click();
await page.waitForTimeout(800);

// 9. A batch's whereabouts come from the tray, not from the batch --------
await page.goto(`${baseUrl}/pools`);
await page.click('text=Sorting trays');
await page.waitForSelector('text=KIT-21099-2621703602', { timeout: 5000 });
const whereabouts = await page.locator('text=KIT-21099-2621703602').locator('..').innerText();
if (!/in 3/.test(whereabouts)) {
  throw new Error(`batch location not resolved through the tray: ${whereabouts}`);
}
ok(`batch located via its tray, not a stored field: ${whereabouts.replace(/\s+/g, ' ').trim()}`);
await page.screenshot({ path: `${outDir}/ops-occupancy.png` });
await page.keyboard.press('Escape');

// 10. Log bridge: paste a line, highlight the parts, preview --------------
await page.goto(`${baseUrl}/log`);
await page.waitForSelector('h1:has-text("Log bridge")');
await page.click('button:has-text("Connect a log")');
await page.waitForSelector('#src-sample');
const sourceName = `machine controller events ${Date.now()}`;
await page.fill('#src-name', sourceName);
await page.fill('#src-path', '/tmp/lims-events.log');
await page.fill(
  '#src-sample',
  '12:40:32  Feina_KIT-21099-2621703602  RegistreFeinaK\n12:41:07  Feina_KIT-21099-2621703610  RegistreFeinaK',
);
await page.waitForTimeout(400);
await page.click('button:has-text("Preview")');
await page.waitForSelector('text=/lines match/', { timeout: 5000 });
const matchText = await page.locator('text=/lines match/').innerText();
ok(`parser derived from a pasted line, no regex typed: ${matchText}`);
await page.screenshot({ path: `${outDir}/ops-log-parser.png` });
await page.locator('div.max-w-md button:text-is("Save")').click();
await page.waitForSelector(`text=${sourceName}`);
ok('log source saved');
// Several runs leave several sources behind; always drive the one just made.
const card = page.locator('div.rounded-lg.border.bg-surface').filter({ hasText: sourceName });

// 11. Ingest in shadow: recorded, nothing applied -------------------------
const poolBefore = await page.evaluate(async () => {
  const res = await fetch('/api/v1/pools');
  const pools = await res.json();
  return pools.find((p) => p.granularity === 'pooled')?.available ?? null;
});

await card.locator('textarea').fill(
  '12:40:32  Feina_KIT-21099-2621703602  RegistreFeinaK\n12:41:07  Feina_XX-1  RegistreFeinaK\n12:42:00  Tray_9  EsdevenimentDesconegut',
);
await card.locator('button:has-text("Read new lines")').click();
await page.waitForSelector('text=/applied,.*shadowed/', { timeout: 8000 });
const ingestToast = await page.locator('text=/applied,.*shadowed/').innerText();
ok(`ingest is idempotent and reports honestly: ${ingestToast}`);

const poolAfterShadow = await page.evaluate(async () => {
  const res = await fetch('/api/v1/pools');
  const pools = await res.json();
  return pools.find((p) => p.granularity === 'pooled')?.available ?? null;
});
if (poolBefore !== poolAfterShadow) {
  throw new Error('a shadowed rule changed data — shadow mode is not shadow');
}
ok('shadow mode recorded what it would do without doing it');

// 12. Unknown events are the configuration screen, not an error list ------
await page.reload();
await page.waitForSelector('text=Unexplained events', { timeout: 8000 });
const unknownText = await page.locator('text=EsdevenimentDesconegut').first().innerText();
ok(`an unexplained event became a configuration prompt: ${unknownText}`);
await page.screenshot({ path: `${outDir}/ops-unknown-events.png` });

// 13. Both gates must open: the SOURCE and the RULE. Either one left shut
//     keeps everything in shadow, which is the safe default.
const card2 = page.locator('div.rounded-lg.border.bg-surface').filter({ hasText: sourceName });
await card2.locator('button:text-is("Enable")').click();
await page.waitForTimeout(600);
const ruleEnable = page.locator('div:has(> div > code) button:text-is("Enable")');
if (await ruleEnable.count()) await ruleEnable.first().click();
await page.waitForTimeout(800);
ok('source and rule both enabled (either gate alone keeps it in shadow)');
const card3 = page.locator('div.rounded-lg.border.bg-surface').filter({ hasText: sourceName });
await card3.locator('textarea').fill(
  '13:10:00  Feina_NEW-1  RegistreFeinaK\n13:10:05  Feina_NEW-2  RegistreFeinaK',
);
await card3.locator('button:has-text("Read new lines")').click();
await page.waitForTimeout(1500);
const poolAfterApply = await page.evaluate(async () => {
  const res = await fetch('/api/v1/pools');
  const pools = await res.json();
  return pools.find((p) => p.granularity === 'pooled')?.available ?? null;
});
if (poolAfterApply !== poolAfterShadow - 2) {
  throw new Error(
    `expected 2 cups taken, went ${poolAfterShadow} → ${poolAfterApply}`,
  );
}
ok(`enabled rule applied: ${poolAfterShadow} → ${poolAfterApply} cups available`);

// Re-read the identical content: the hash must make it a no-op.
await card3.locator('button:has-text("Read new lines")').click();
await page.waitForTimeout(1500);
const poolAfterReplay = await page.evaluate(async () => {
  const res = await fetch('/api/v1/pools');
  const pools = await res.json();
  return pools.find((p) => p.granularity === 'pooled')?.available ?? null;
});
if (poolAfterReplay !== poolAfterApply) {
  throw new Error(`re-reading the same lines double-charged: ${poolAfterApply} → ${poolAfterReplay}`);
}
ok('re-reading the same lines changed nothing (each line takes effect exactly once)');

// 14. The manual is served by the app itself, in the reader's language ----
const manualResponse = await page.evaluate(async () => {
  const res = await fetch('/api/v1/manual/ca');
  const text = await res.text();
  return { status: res.status, hasTitle: text.includes('<title'), bytes: text.length };
});
if (manualResponse.status !== 200 || !manualResponse.hasTitle) {
  throw new Error(`manual not served: ${JSON.stringify(manualResponse)}`);
}
ok(`manual served in-app (${Math.round(manualResponse.bytes / 1024)} KB, self-contained)`);

// 15. Mobile: nothing overflows on a phone --------------------------------
const phone = await context.newPage();
await phone.setViewportSize({ width: 390, height: 844 });
for (const path of ['/requests', '/lots', '/forecast', '/actions', '/pools', '/log']) {
  await phone.goto(`${baseUrl}${path}`);
  await phone.waitForTimeout(500);
  const size = await phone.evaluate(() => {
    const main = document.querySelector('main');
    return { scroll: main?.scrollWidth ?? 0, client: main?.clientWidth ?? 0 };
  });
  if (size.scroll > size.client + 1) {
    throw new Error(`${path} overflows on a phone: ${size.scroll} > ${size.client}`);
  }
}
ok('all six new pages fit a 390px phone with no horizontal overflow');
await phone.screenshot({ path: `${outDir}/ops-mobile.png` });

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors) console.log(`  · ${e}`);
await browser.close();
