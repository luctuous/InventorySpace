# Single-container build: API + built frontend + SQLite.
#   docker build -t inventoryspace .
#   docker run -d -p 3000:3000 -v ./inventory-data:/data inventoryspace

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

# better-sqlite3 is a native module — it needs a toolchain to compile.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build -w @inventory/web \
 && npm run build -w @inventory/api \
 && npm run docs:manuals \
 && npm prune --omit=dev

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/inventory.db \
    SERVE_WEB=1 \
    WEB_DIST=/app/packages/web/dist \
    MANUAL_DIR=/app/docs

# The workspace layout is preserved on purpose: npm keeps some packages in
# packages/*/node_modules instead of hoisting, so flattening breaks resolution.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/api/package.json ./packages/api/package.json
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/drizzle ./packages/api/drizzle
COPY --from=build /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist
# Both manuals — the user one and the architecture one — served in-app by the
# "?" in the sidebar. Self-contained HTML with the fonts inlined, so they work
# with no network at all.
COPY --from=build /app/docs/manual.*.html /app/docs/code.*.html ./docs/

VOLUME /data
EXPOSE 3000

# Migrations run at boot, so a fresh volume just works.
CMD ["node", "packages/api/dist/index.js"]
