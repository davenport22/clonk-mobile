# Deploying Undermine

Two pieces, two hosts, and one reason they cannot be the same host.

| Piece | What it is | Where it goes |
|---|---|---|
| The game | Static files. 46 kB gzipped, no backend, no database. | Vercel |
| The relay | One Node process holding WebSocket connections and sequencing input | Render, Fly or Railway |

**Why not both on Vercel.** Vercel runs serverless functions, which exist for the
duration of a request and cannot hold a socket open. The relay's whole job is holding
sockets open for fifteen minutes and emitting a bundle on every one of them thirty times
a second. There is no Vercel configuration that does this; it needs a process that stays
running. Everything else about Vercel suits the game perfectly, so the split is worth it.

Solo play needs no relay at all.

---

## 1. The game, on Vercel

The repository already contains `vercel.json`, so this is an import rather than a setup.

```bash
npx vercel login
npx vercel --prod
```

Or, from the dashboard: **Add New → Project → Import** the GitHub repository. Vercel reads
`vercel.json` and needs nothing else. Every push to `main` redeploys.

Set one environment variable so the game knows where its relay lives:

| Name | Value |
|---|---|
| `VITE_RELAY_URL` | `wss://your-relay-host.onrender.com` |

It is read at build time (`src/net/client.ts`), so changing it needs a redeploy. Until it
is set, online play falls back to the page's own host and will fail; solo still works.

## 2. The relay

Pick one. All three read the `Dockerfile` in the repository.

### Render (simplest, has a free tier)

**New → Blueprint**, point it at the repository. `render.yaml` describes the service.
Free instances sleep when idle and take a few seconds to wake, which is the right trade
for a game that is not being played at four in the morning.

### Fly.io

```bash
fly auth login
fly launch --copy-config --now
```

`fly.toml` suspends the machine when no one is connected and wakes it on the next
request. Rooms live in memory, so a suspend loses any empty rooms - which is exactly what
should happen to them.

### Railway

**New Project → Deploy from GitHub repo.** Railway detects the `Dockerfile`. Set `PORT`
to `8787`.

### Anywhere with Docker

```bash
docker build -t undermine-relay .
docker run -p 8787:8787 undermine-relay
```

## 3. Check it

```bash
curl https://your-relay-host/health
```

```json
{ "ok": true, "rooms": 0, "roomsCreated": 0, "roundsStarted": 0, "desyncs": 0 }
```

`desyncs` is the number that matters (PRD 6.6). It should stay at zero. If it climbs, the
relay log names which half broke - the input stream or the simulation.

---

## Playing on a phone without deploying anything

Both devices on the same wifi:

```bash
npm run build && npm run relay
```

The relay serves the built game as well as handling multiplayer, so the phone only needs
one address. Find the machine's LAN address and open `http://<address>:8787` on the phone.

One real limitation: a service worker needs a secure context, and `http://192.168.x.x` is
not one. The game plays fine and multiplayer works, but **Add to Home Screen and offline
mode need HTTPS**, so for those you need the deployed version.

If you want a public HTTPS URL for a few minutes without deploying - to let someone
outside your network join - a tunnel does it without an account:

```bash
npx cloudflared tunnel --url http://localhost:8787
```

That prints a `trycloudflare.com` address which works from anywhere, including mobile
data, and disappears when you stop it.

---

## What runs in CI

`.github/workflows/ci.yml` runs on every push: typecheck, the determinism boundary lint,
77 tests, the two-process determinism harness over 10 000 ticks, a production build, and
the 4 MB bundle budget. A red build means do not deploy - in particular, a determinism
failure means multiplayer is broken even if the game looks fine.
