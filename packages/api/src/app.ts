import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRoute, z } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { swaggerUI } from '@hono/swagger-ui';
import { auth } from './auth';
import { createRouter } from './lib/router';
import { errorBody, onError } from './middleware/error';
import { analogousRouter } from './routes/analogous';
import { conceptsRouter } from './routes/concepts';
import { equipmentRouter } from './routes/equipment';
import { historyRouter } from './routes/history';
import { itemsRouter } from './routes/items';
import { actionsRouter } from './routes/actions';
import { forecastRouter } from './routes/forecast';
import { locationsRouter } from './routes/locations';
import { logRouter } from './routes/logbridge';
import { lotsRouter } from './routes/lots';
import { poolsRouter } from './routes/pools';
import { publicRouter } from './routes/public';
import { requestsRouter } from './routes/requests';
import { transferRouter } from './routes/transfer';
import { trashRouter } from './routes/trash';
import { typesRouter } from './routes/types';
import { usersRouter } from './routes/users';
import { variantsRouter } from './routes/variants';

export const app = createRouter();

app.onError(onError);
app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));

// better-auth owns everything under /api/auth/* (sign-up, sign-in, session…).
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// The unauthenticated surface: the workshop's branding and the read-only stock
// overview. Deliberately one small router — see routes/public.ts.
app.route('/api/v1', publicRouter);

app.route('/api/v1', conceptsRouter);
app.route('/api/v1', historyRouter);
app.route('/api/v1', typesRouter);
app.route('/api/v1', locationsRouter);
app.route('/api/v1', analogousRouter);
app.route('/api/v1', variantsRouter);
app.route('/api/v1', itemsRouter);
app.route('/api/v1', usersRouter);
app.route('/api/v1', trashRouter);
app.route('/api/v1', transferRouter);
//
app.route('/api/v1', requestsRouter);
app.route('/api/v1', lotsRouter);
app.route('/api/v1', forecastRouter);
app.route('/api/v1', actionsRouter);
app.route('/api/v1', poolsRouter);
app.route('/api/v1', logRouter);
app.route('/api/v1', equipmentRouter);

const healthRoute = createRoute({
  method: 'get',
  path: '/api/v1/health',
  tags: ['meta'],
  responses: {
    200: {
      description: 'Service health',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), version: z.string() }),
        },
      },
    },
  },
});
app.openapi(healthRoute, (c) => c.json({ ok: true, version: '0.1.0' }, 200));

// OpenAPI spec + docs UI. The spec doubles as handover documentation —
// a buyer's team (or a future mobile app) consumes the API from here.
app.doc('/api/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Workshop Inventory API',
    version: '0.1.0',
    description:
      'Self-hosted inventory: Concept → Analogous → Variant → Item, ' +
      'plus Locations, Types, and an append-only History.',
  },
});
app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

// The manuals, served from inside the app so the "?" in the sidebar opens them
// without leaving the product or needing a network. The files are the
// self-contained builds from docs/build-manuals.mjs (fonts inlined, no CDN).
//
// Two documents: `manual` is for the people using the app, `code` is the
// architecture manual for whoever maintains it. Both are matched against a
// fixed pattern rather than interpolated, because this reads a path from a URL
// and `../` is the oldest trick there is.
const MANUAL_DIR = process.env.MANUAL_DIR ?? new URL('../../../docs', import.meta.url).pathname;

async function serveManual(doc: 'manual' | 'code', locale: string) {
  if (!/^(en|de|ca)$/.test(locale)) return null;
  return readFile(join(MANUAL_DIR, `${doc}.${locale}.html`), 'utf8').catch(() => null);
}

app.get('/api/v1/manual/:locale', async (c) => {
  const html = await serveManual('manual', c.req.param('locale'));
  if (html === null) {
    return c.json(
      errorBody('manual_missing', 'Run `npm run docs:manuals` to build the manual'),
      404,
    );
  }
  return c.html(html);
});

app.get('/api/v1/manual/code/:locale', async (c) => {
  const html = await serveManual('code', c.req.param('locale'));
  if (html === null) {
    return c.json(
      errorBody('manual_missing', 'Run `npm run docs:manuals` to build the manual'),
      404,
    );
  }
  return c.html(html);
});

// In production the API also serves the built React bundle from the same
// port, so the whole product is one container on one URL.
// Registered LAST so it never shadows an API route; any non-/api path falls
// back to index.html for client-side routing.
if (process.env.SERVE_WEB) {
  const webRoot = process.env.WEB_DIST ?? './web';
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api')) return next();
    const html = await readFile(join(webRoot, 'index.html'), 'utf8').catch(() => null);
    return html ? c.html(html) : next();
  });
}
