// Role gates, the purchasing chain, concurrency and bulk import — the places
// where the app has to hold up under a second person, a wrong number, or ten
// things happening at once.
//
// Usage: node scripts/verify-limits.mjs [apiBaseUrl] [user] [pass]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates a viewer
// account called `probeviewer` (reused on later runs), a request, a lot, and a
// handful of items. Point it at a scratch copy, never at the workshop's real data:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   PORT=3002 DATABASE_PATH=/tmp/scratch.db npx tsx src/index.ts   # in packages/api
//   node scripts/verify-limits.mjs http://localhost:3002
//
// Exits non-zero if anything failed.

const BASE = process.argv[2] ?? 'http://localhost:3001';
const USER = process.argv[3] ?? 'demoadmin';
const PASS = process.argv[4] ?? 'test-1234-test';
console.log(`\n→ ${BASE} — this writes to that database\n`);
let cookie = '';
const findings = [];
const note = (level, area, text) => {
  findings.push({ level, area, text });
  console.log(`${{ PASS: '  ok ', FAIL: 'FAIL ', NOTE: 'NOTE ', WARN: 'WARN ' }[level]} [${area}] ${text}`);
};

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, body };
}
async function signIn(username, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return res.status;
}

await signIn(USER, PASS);

// ================================================== 1. roles
console.log('\n──────── 1. role gates ────────');
{
  const made = await api('/api/v1/users', {
    method: 'POST',
    body: { username: 'probeviewer', name: 'Probe Viewer', email: 'probe@example.com',
            password: 'probe-viewer-1234', role: 'viewer' },
  });
  // Re-runnable: the second run finds the account already there, which is not
  // a failure — it is the same account, and the point is what it may do.
  const adminCookie = cookie;
  const viewerIn = await signIn('probeviewer', 'probe-viewer-1234');
  if (viewerIn !== 200) {
    note('NOTE', 'roles', `no viewer to test with (create ${made.status}, sign-in ${viewerIn}) — skipping`);
    cookie = adminCookie;
  } else {

    const read = await api('/api/v1/items?perPage=5');
    read.status === 200
      ? note('PASS', 'roles', 'a viewer can read items')
      : note('FAIL', 'roles', `viewer read returned ${read.status}`);

    const write = await api('/api/v1/items', {
      method: 'POST',
      body: { typeId: '00000000-0000-4000-8000-000000000000', status: 'in_stock' },
    });
    write.status === 403
      ? note('PASS', 'roles', 'a viewer cannot create items (403)')
      : note('FAIL', 'roles', `viewer create returned ${write.status}, expected 403`);

    const items = (await api('/api/v1/items?perPage=5')).body.data;
    const link = await api(`/api/v1/items/${items[0].id}/links`, {
      method: 'POST', body: { childItemId: items[1].id, relation: 'spare' },
    });
    link.status === 403
      ? note('PASS', 'roles', 'a viewer cannot attach equipment (403)')
      : note('FAIL', 'roles', `viewer attach returned ${link.status}`);

    const plan = await api(`/api/v1/items/${items[0].id}/maintenance`, {
      method: 'POST', body: { name: { en: 'x' }, everyDays: 10 },
    });
    plan.status === 403
      ? note('PASS', 'roles', 'a viewer cannot create maintenance plans (403)')
      : note('FAIL', 'roles', `viewer plan returned ${plan.status}`);

    const users = await api('/api/v1/users');
    users.status === 403
      ? note('PASS', 'roles', 'a viewer cannot list users (403)')
      : note('FAIL', 'roles', `viewer GET /users returned ${users.status} — user list exposed`);

    const trash = await api('/api/v1/trash');
    trash.status === 403
      ? note('PASS', 'roles', 'a viewer cannot open the bin (403)')
      : note('FAIL', 'roles', `viewer GET /trash returned ${trash.status}`);

    const commission = await api('/api/v1/pools');
    const poolId = commission.body?.[0]?.id;
    if (poolId) {
      const c = await api(`/api/v1/pools/${poolId}/commission`, { method: 'POST', body: { quantity: 1 } });
      c.status === 403
        ? note('PASS', 'roles', 'a viewer cannot commission stock into a pool (403)')
        : note('FAIL', 'roles', `viewer commission returned ${c.status}`);
    }
    cookie = adminCookie;
  }
}

// ============================================= 2. purchasing flow
console.log('\n──────── 2. requests → lot → receive ────────');
{
  const concepts = (await api('/api/v1/concepts?perPage=50')).body.data;
  const concept = concepts.find((c) => c.humanId === 'CON001');

  const req = await api('/api/v1/requests', {
    method: 'POST', body: { conceptId: concept.id, quantity: 3, urgency: 'normal', note: 'probe' },
  });
  req.status === 201
    ? note('PASS', 'purchasing', 'a request can be raised against a concept')
    : note('FAIL', 'purchasing', `request create returned ${req.status} ${JSON.stringify(req.body).slice(0,150)}`);

  const dup = await api('/api/v1/requests', {
    method: 'POST', body: { conceptId: concept.id, quantity: 1, urgency: 'normal' },
  });
  const existing = await api(`/api/v1/requests/open/${concept.id}`);
  note('NOTE', 'purchasing', `a second request for the same concept: HTTP ${dup.status}; open-for reports ${existing.status === 200 ? 'an existing one' : existing.status}`);

  const suppliers = (await api('/api/v1/suppliers')).body;
  const supplierId = suppliers[0]?.id;
  const lot = await api('/api/v1/lots', { method: 'POST', body: { supplierId } });
  if (lot.status !== 201) {
    note('FAIL', 'purchasing', `lot create returned ${lot.status} ${JSON.stringify(lot.body).slice(0,150)}`);
  } else {
    const lotId = lot.body.id;
    const variants = (await api(`/api/v1/lots/suggest/${concept.id}`)).body;
    const variantId = variants?.[0]?.variantId ?? variants?.[0]?.id;

    const line = await api(`/api/v1/lots/${lotId}/lines`, {
      method: 'POST',
      body: { conceptId: concept.id, orderedVariantId: variantId, orderedQuantity: 2, unitPrice: '41.80' },
    });
    line.status === 201
      ? note('PASS', 'purchasing', 'a line can be added to a draft lot')
      : note('FAIL', 'purchasing', `line create returned ${line.status} ${JSON.stringify(line.body).slice(0,200)}`);

    const negPrice = await api(`/api/v1/lots/${lotId}/lines`, {
      method: 'POST',
      body: { conceptId: concept.id, orderedVariantId: variantId, orderedQuantity: 1, unitPrice: '-5.00' },
    });
    negPrice.status === 400
      ? note('PASS', 'purchasing', 'a negative price is refused')
      : note('WARN', 'purchasing', `negative price returned ${negPrice.status}`);

    const zeroQty = await api(`/api/v1/lots/${lotId}/lines`, {
      method: 'POST',
      body: { conceptId: concept.id, orderedVariantId: variantId, orderedQuantity: 0, unitPrice: '1.00' },
    });
    zeroQty.status === 400
      ? note('PASS', 'purchasing', 'ordering zero of something is refused')
      : note('WARN', 'purchasing', `quantityOrdered=0 returned ${zeroQty.status}`);

    const ordered = await api(`/api/v1/lots/${lotId}/order`, {
      method: 'POST', body: { reference: 'PROBE-001' },
    });
    ordered.status === 200
      ? note('PASS', 'purchasing', 'the order reference is taken at the ordering step')
      : note('FAIL', 'purchasing', `order returned ${ordered.status} ${JSON.stringify(ordered.body).slice(0,150)}`);

    const editAfter = await api(`/api/v1/lots/${lotId}/lines`, {
      method: 'POST',
      body: { conceptId: concept.id, orderedVariantId: variantId, orderedQuantity: 1, unitPrice: '1.00' },
    });
    editAfter.status >= 400
      ? note('PASS', 'purchasing', `an ordered lot is closed to new lines (${editAfter.status})`)
      : note('WARN', 'purchasing', `line added to an ordered lot (${editAfter.status})`);

    const detail = (await api(`/api/v1/lots/${lotId}`)).body;
    const lineId = detail.lines?.[0]?.id;
    if (!lineId) { note('NOTE', 'purchasing', 'no line on the lot, skipping receive checks'); }
    else {
    const stockBefore = (await api('/api/v1/concepts/stock')).body[concept.id];

    const over = await api(`/api/v1/lots/${lotId}/receive`, {
      method: 'POST',
      body: { lines: [{ lineId, receivedQuantity: 99 }] },
    });
    const stockAfterOver = (await api('/api/v1/concepts/stock')).body[concept.id];
    over.status >= 400
      ? note('PASS', 'purchasing', `receiving far more than ordered is refused (${over.status})`)
      : note('NOTE', 'purchasing', `received 99 of 2 ordered: HTTP ${over.status}, stock ${stockBefore} → ${stockAfterOver} (over-delivery allowed by design)`);
    }
  }
}

// ============================================== 3. concurrency
console.log('\n──────── 3. concurrency ────────');
{
  const action = (await api('/api/v1/actions')).body[0];
  const before = (await api('/api/v1/concepts/stock')).body;
  const openNow = (await api('/api/v1/items?status=open&perPage=100')).body.data;
  const target = openNow.find((i) => action.lineDetails?.some((l) => l.conceptId === i.conceptId));
  const chargedBefore = target?.estimatedUsed ?? 0;
  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      api('/api/v1/action-records', { method: 'POST', body: { actionId: action.id, count: 1 } }),
    ),
  );
  const okCount = results.filter((r) => r.status === 201).length;
  const after = (await api('/api/v1/concepts/stock')).body;

  // Pick a concept that HAS an open container: an unbacked one is reported,
  // not charged, and comparing against it measures nothing.
  const open = (await api('/api/v1/items?status=open&perPage=100')).body.data;
  const line = action.lineDetails?.find(
    (l) => l.conceptId && open.some((i) => i.conceptId === l.conceptId),
  );
  if (line) {
    // The real no-lost-update invariant is the container's own charged figure:
    // stock is clamped at zero, so an already-empty container legitimately
    // absorbs charges without moving stock, but `estimatedUsed` must rise by
    // exactly the sum of what landed — no more, no less.
    const landed = results
      .flatMap((r) => r.body?.charged ?? [])
      .filter((c) => c.conceptId === line.conceptId && !c.unbacked);
    const itemId = landed[0]?.itemId;
    const total = landed.reduce((sum, c) => sum + c.quantity, 0);
    const container = itemId ? (await api(`/api/v1/items/${itemId}`)).body : null;
    const rose = container ? container.estimatedUsed - chargedBefore : null;

    rose !== null && Math.abs(rose - total) < 0.0015
      ? note('PASS', 'concurrency', `${okCount} simultaneous recordings each landed exactly once on ${container.humanId} (charged rose by ${rose.toFixed(3)}, ${total.toFixed(3)} recorded)`)
      : note('FAIL', 'concurrency', `lost update: charged rose ${rose === null ? '?' : rose.toFixed(3)} but ${total.toFixed(3)} was recorded`);
  }

  // humanId generation under load
  const types = (await api('/api/v1/types')).body;
  const type = types.find((t) => t.key === 'supply') ?? types[0];
  const locations = (await api('/api/v1/locations')).body;
  const created = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/api/v1/items', {
        method: 'POST',
        body: { typeId: type.id, status: 'in_stock', locationId: locations[0].id, customFields: {} },
      }),
    ),
  );
  const ids = created.filter((r) => r.status === 201).flatMap((r) => r.body.map((i) => i.humanId));
  new Set(ids).size === ids.length && ids.length > 0
    ? note('PASS', 'concurrency', `${ids.length} items created at once got ${new Set(ids).size} distinct ids`)
    : note('FAIL', 'concurrency', `duplicate humanIds under load: ${ids.join(', ')}`);
}

// =============================================== 4. the log bridge
console.log('\n──────── 4. the log bridge ────────');
{
  const events = await api('/api/v1/log/events');
  const sources = await api('/api/v1/log/sources');
  note('NOTE', 'log', `${events.body?.length ?? '?'} dictionary entr(ies), ${sources.body?.length ?? '?'} source(s)`);

  const src = sources.body?.[0];
  if (src) {
    const content = '12:40:32  Feina_TEST-1  RegistreFeinaK\n12:40:33  Feina_TEST-2  RegistreFeinaK';
    const first = await api(`/api/v1/log/sources/${src.id}/ingest`, { method: 'POST', body: { content } });
    const second = await api(`/api/v1/log/sources/${src.id}/ingest`, { method: 'POST', body: { content } });
    const a = first.body?.applied ?? first.body?.lines?.length;
    const b = second.body?.applied ?? 0;
    b === 0 || JSON.stringify(second.body).includes('duplicate') || (second.body?.skipped ?? 0) > 0
      ? note('PASS', 'log', `re-ingesting the same lines does not double-charge (first ${JSON.stringify(first.body).slice(0,90)}, second ${JSON.stringify(second.body).slice(0,90)})`)
      : note('FAIL', 'log', `the same content applied twice: ${JSON.stringify(second.body).slice(0,160)}`);
  } else {
    note('NOTE', 'log', 'no log source configured, skipping ingestion checks');
  }
}

// ================================================= 5. CSV round trip
console.log('\n──────── 5. CSV ────────');
{
  const res = await fetch(`${BASE}/api/v1/export/items.csv`, { headers: { cookie } });
  const csv = await res.text();
  res.status === 200 && csv.split('\n').length > 1
    ? note('PASS', 'csv', `export returns ${csv.split('\n').length - 1} data row(s)`)
    : note('FAIL', 'csv', `export returned ${res.status}`);

  const injection = 'humanId,typeKey,status\n"=cmd|calc",supply,in_stock';
  const imp = await api('/api/v1/import/items', { method: 'POST', body: { csv: injection, dryRun: true } });
  note('NOTE', 'csv', `a formula-looking cell on import: HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 140)}`);

  const broken = await api('/api/v1/import/items', { method: 'POST', body: { csv: 'not,a,valid\nheader', dryRun: true } });
  broken.status >= 400
    ? note('PASS', 'csv', `a malformed CSV is rejected (${broken.status})`)
    : note('WARN', 'csv', `malformed CSV returned ${broken.status}`);
}

console.log('\n════════ summary ════════');
console.log(JSON.stringify(findings.reduce((a, f) => ({ ...a, [f.level]: (a[f.level] ?? 0) + 1 }), {})));
const bad = findings.filter((f) => f.level === 'FAIL' || f.level === 'WARN');
if (bad.length) {
  console.log('\nNeeds a look:');
  for (const f of bad) console.log(`  ${f.level} [${f.area}] ${f.text}`);
}

const failed = findings.filter((f) => f.level === 'FAIL');
if (failed.length > 0) process.exit(1);
