# Inventory

A self-hosted inventory app for hobbyists, side hustles, workshops and small
teams. One container, one database file, your data stays yours.

Every physical thing you own is an **Item**, seen through four lenses:
what it does (**Concept**), which products satisfy that need (**Analogous** →
**Variant**), the physical unit itself (**Item**), and where it lives
(**Location**). If that sounds like too much: ignore it. **Quick Add** takes a
name, a type and a quantity, and builds the rest for you.

## Quick start (Docker)

```bash
docker build -t inventoryspace .
docker run -d -p 3000:3000 -v ./inventory-data:/data inventoryspace
```

Open <http://localhost:3000>. The first account you register becomes the
**admin**; after that, registration closes and the admin creates accounts from
the Users page.

Nothing else to configure. The key that signs session cookies is generated on
first start and kept in `inventory-data/auth-secret`, next to the database — so
restarts do not sign everybody out, and backing up the data directory backs up
both. Set `BETTER_AUTH_SECRET` if you would rather supply it yourself; it wins
when present.

## Signing in, and who can see what

Three things about accounts are decisions rather than defaults, and you should
know them before you put this on a shared network.

**The stock board is readable without an account.** Opening the address without
signing in shows concept names, quantities, what is low or empty, and the
location tree — and nothing else. No item rows, so no serial numbers, no batch
numbers, no prices, no notes, no names of people. It is meant as a noticeboard:
"is there any wood glue left?", answered without borrowing somebody's login. If
your stock list is not something you would pin to a noticeboard, keep the
server off the shared network.

**Shared computers sign themselves out** after twenty minutes idle, with a
minute's warning. That is not about theft; it is about the record. A browser
left signed in makes every change look like the work of whoever walked away
last, and the history is the one thing here that has to be trustworthy.

**Your own computer can opt out.** *Remember this computer*, confirmed with
your password, keeps that browser signed in as you through shutdowns and
reboots, and never times out. The claim belongs to one person: a colleague
signing in there gets an ordinary session that expires, and the desk stays
yours. An admin can end every session everywhere — claimed computers included —
from the Users page.

There is also a **key chord** shortcut: two clusters of letters held down sign
you in, switch user, or sign you out, without typing anything. Treat it like a
code on a door rather than a password; see the manual.

## Showing it to other people

The app is one server that everybody else reaches over the network, so a demo
is one machine running it and a URL you read out.

```bash
docker build -t inventoryspace .
mkdir demo-data
docker run -d -p 3000:3000 -v ./demo-data:/data inventoryspace
hostname -I | awk '{print $1}'        # the address to give people
```

Colleagues open `http://<that address>:3000` — nothing to install on their
machines. The first person to register becomes the admin; after that the admin
creates accounts. Throw the demo away by deleting `demo-data`.

Two things worth knowing before you stand in front of anybody:

- **The server prints its own address, not the host's, when it runs in a
  container.** Docker only lets it see the bridge network, so it says so rather
  than printing an address that does not work. Use `hostname -I`.
- **Plain HTTP is the supported case**, not an oversight: session cookies are
  only marked `Secure` when you set `BETTER_AUTH_URL=https://…`, because a
  browser silently discards a `Secure` cookie sent over `http://192.168.x.x`
  and everybody would be signed out by their first reload.

If the workshop machines cannot reach yours, the firewall is the first thing to
check — on this machine `ufw` was active.

## Manuals

Two manuals ship with the repo, each in three languages. The user manual is
what the app does; the code manual is how it is built, file by file.

- [`docs/manual.en.html`](docs/manual.en.html) · [`de`](docs/manual.de.html) · [`ca`](docs/manual.ca.html) — using it
- [`docs/code.en.html`](docs/code.en.html) · [`de`](docs/code.de.html) · [`ca`](docs/code.ca.html) — maintaining it

Each one is a complete, standalone HTML file. Double-click it, or:

```bash
xdg-open docs/manual.en.html    # macOS: open
```

There are no external requests at all — the fonts are embedded — so they work
offline, can be emailed, or dropped on any web server. Keep the three files
together and the language switcher in the corner works; the button next to it
toggles light/dark.

The user manual covers the data model, clearing the demo data, a from-scratch
tutorial, daily use, roles, backups and the current limitations. The code
manual walks the ~28,000 lines package by package and ends with the traps.
Both are also served from inside the app, behind the `?` in the sidebar.

The pages are generated from `docs/manual.css` + `docs/content/*.html`; after
editing either, run:

```bash
npm run docs:manuals
```

## Backup

The entire database is one file: `inventory-data/inventory.db`. Stop the container, copy
the file, done. (WAL mode also leaves `inventory.db-wal` / `inventory.db-shm` next to it —
copy those too, or stop the container first so they are folded in.)

## Development

Requires Node 20+.

```bash
npm install
npm run db:seed     # optional demo data — only runs on an empty database
npm run dev         # API on :3001, web on :5173
```

Open <http://localhost:5173>.

| Command | What it does |
|---|---|
| `npm run dev` | API + web dev servers together |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Production build (API bundle + web bundle) |
| `npm run db:generate` | Generate a migration after changing the schema |
| `npm run db:seed` | Seed demo data into an empty database |

Migrations run automatically when the API starts, so a fresh database needs no
setup step.

### Creating a user from the command line

```bash
cd packages/api
npx tsx --env-file-if-exists=.env scripts/create-user.mts \
  theirusername "their-password" "Their Name" operator
```

People sign in with a **username**, not an email — free-form, so `anna`,
`Anna Müller` and `torn-nit` all work. An email is an optional fifth argument,
there only so an account can be tied to a mailbox later.

Roles: `viewer` · `operator` · `manager` · `admin`.

### Browser smoke test

```bash
npm run dev                                    # in one terminal
node packages/web/scripts/smoke.mjs ./shots <username> <password>
```

Drives the whole app in headless Chromium and writes screenshots to `./shots`.

## Desktop app

`packages/desktop` is a small Tauri client: it asks which server, checks it
answers, and shows the app in a real window — no address bar to wander out of,
and a keyboard the system hands straight to it, which is what makes the
key-chord fast login practical on a shared bench.

It is a **client**. The server still holds the one database everybody shares;
the desktop app does not carry its own.

```bash
npm run dev   -w @inventory/desktop     # run it
npm run build -w @inventory/desktop     # release binary
npx tauri build --bundles deb     # …or an installer, from packages/desktop
```

Needs Rust (`rustup`), plus `webkit2gtk-4.1`, `libsoup-3` and GTK 3 on Linux.
*Change server…* in the menu points it somewhere else.

## Layout

```
packages/
  shared/   @inventory/shared — Zod schemas + types shared by API and web
  api/      Hono + Drizzle + SQLite, REST at /api/v1, OpenAPI at /api/docs
  web/      React + Vite + Tailwind
  desktop/  Tauri client — a window onto a server, not a second server
```

The code manual in `docs/` walks the whole thing package by package.

## API

The API is a normal REST service documented by an OpenAPI spec — browse it at
<http://localhost:3000/api/docs> (or `:3001` in dev). Everything the UI does,
a script or a future mobile app can do too.

## Licence

[MIT](LICENSE). Use it, change it, sell it — just keep the copyright notice.
