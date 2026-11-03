# Undermine

A 2D destructible-terrain sandbox multiplayer game for the phone, delivered as a PWA.

> Dig, build, sabotage. One round is a coffee break.

Built from `PRD-clonk-mobile.md` (working title "Pocket Clonk"). This README records what
was actually built, the decisions taken along the way, and where the PRD and the code
disagree.

**Ship name:** `Undermine`, chosen from the PRD 3.4 shortlist. Open question Q1 is
therefore answered provisionally — change it in `index.html`, `vite.config.ts`
(manifest) and `src/ui/app.ts` if you prefer Digworld, Gravel or Deep Cut.

---

## Run it

```bash
npm install
```

Client only (solo play works with no server at all):

```bash
npm run dev
```

Relay for online play, in a second terminal:

```bash
npm run relay
```

Then open http://localhost:5173, tap **Create a room**, and share the link (it carries
`?r=CODE`). Solo play needs no relay.

One-box production: `npm run build && npm run relay` — the relay serves `dist/` itself,
so a single small VM hosts the whole game (PRD 6.6).

Everything checked in CI, in one command:

```bash
npm run verify
```

### On a PC

It plays properly with a mouse and keyboard, not just as a development stopgap:

| Input | Does |
|---|---|
| `WASD` / arrows | Move, climb, swim, ride the elevator |
| Mouse | Aim. The shovel digs where the crosshair is, not where the legs are going |
| Left click | Use the selected tool |
| `1`-`4`, `Q`/`E`, right click | Pick a tool |
| `G` | Throw what you are carrying |
| Space | Jump |
| Wheel, `+`/`-` | Zoom |
| `Tab` | Tactical view |
| `F` | Fullscreen |

The on-screen thumb controls hide themselves the moment you touch a mouse or a key, and
come back the moment you touch the screen - so a laptop with a touchscreen works either
way, and a phone player and a desktop player can share the same round.

Aim is a separate two-byte channel in the input frame, alongside the stick rather than
instead of it. That keeps PRD 5.2's thumb scheme intact while giving a mouse the thing a
mouse is actually good at, and it means desktop aim travels through the relay and is
exactly as deterministic as a phone player's stick. It also answers open question Q2 with
"both, depending on what you are holding".

---

## What is built

| PRD ID | Feature | State |
|---|---|---|
| M1 | Destructible material grid | Done. Earth, rock, coal, ore, gold, sand, water, granite, loose earth, structures, wood, leaves. Digging, collapse, falling material, water flow. |
| M2 | Clonk character control | Done. Walk, jump, climb, swim, dig, chop, carry one object, throw. Health, breath, fall damage, death and respawn. All fixed-point. |
| M3 | Touch control scheme | Done. Floating-origin stick, one contextual button, press-and-drag radial with four entries. **Not yet validated on a phone with real players - see the gate below.** Desktop mouse and keyboard also fully supported. |
| M4 | Deterministic simulation core | Done and enforced. Fixed-point Q16.16, 30 Hz, lint gate, CI hash comparison over 10 000 ticks. |
| M5 | Online lockstep, 4 players | Done for the mechanism; verified with 2 clients against a real relay. 4-player and mobile-network testing outstanding. |
| M6 | Lobby and matchmaking by link | Done. Room codes, shareable `?r=CODE` link, nickname only, no accounts. |
| M7 | Procedural island generator | Done. Seeded, deterministic, 2D density field with cliffs, overhangs, arches, chasms and a cave network. |
| M8 | One win condition | Done. Gold Rush: first team to bank N gold, or most gold at the 15 minute mark. |
| M9 | Minimal build system | Done. Flagpole, Foundry, Elevator, Lorry, Shovel - plus dynamite and loam, which need no building. |
| M10 | PWA shell | Done. Installable, offline shell, wake lock, safe-area HUD, rotate prompt, audio unlocked on the join tap. |
| S3 | Basic sound | Done, synthesised — no audio files. |
| S1 | Melee mode | **Done.** Shovel melee, thrown chunks that hurt, kill scoring, chosen in the lobby. |
| S2 | Explosives | **Done.** Dynamite with a lit fuse, chain reactions, terrain-reshaping blasts, structure destruction. |
| S5 | Reconnect | **Done.** A seat is held for two minutes and the same nickname takes it back, with a state resync. |
| S6 | 8 players | **Done.** Eight slots, any mix of people and bots. |
| C4 | Bot fill | **Done.** Empty slots become bots, computed from world state on every client so they cost no bandwidth. |
| S4 | Spectator after elimination | Not built - and not needed, because death is a respawn rather than elimination. |
| C1–C4 | Haptics, cosmetics, stats card, bots | Not built. C1 is impossible on iOS web anyway (PRD 6.7). |

### Measured against the PRD's non-functional requirements

| Requirement | Target | Measured |
|---|---|---|
| Initial payload | < 4 MB gzipped | **50 kB** total, 41 kB of JS. No asset downloads at all. |
| Simulation tick | < 12 ms at 30 Hz | **0.10–0.28 ms** per tick, 4 players, heavily dug map (desktop; `npm run check:determinism` prints it) |
| Island generation | < 500 ms | ~50 ms warm, ~190 ms cold |
| Determinism | identical state hash over 10 000 ticks | Passes on 3 seeds, two independent worker processes |
| Desync rate | < 1 in 1000 rounds | Not measurable yet. Detection, diagnosis and recovery are implemented and tested. |
| Frame rate, battery, network | 60 fps on iPhone 13, < 12 % drain, playable at 150 ms RTT | **Not measured. Needs a real device.** |

The three unmeasured rows are the honest gap in this build: everything here has been
verified on a desktop browser and in Node. The PRD's real gate (PRD 8.1) is three people
on a phone, and that has not happened.

---

## Architecture decisions

### ADR-001: engine strategy — inherited from the PRD

Option B from PRD 6.1: a purpose-built TypeScript engine reusing OpenClonk's *design*,
not its code. Implemented as specified. The simulation sits behind a clean boundary
(`src/sim`, importing only `src/fx` and `src/data`) precisely so the WASM escape hatch
stays open if the TS simulation misses its budget on a phone.

It currently runs at a few tenths of a millisecond per tick on a desktop against a 12 ms
budget, so the escape hatch has not been needed. Open question Q7 (spike a WASM grid module now?) can be
answered *no for now* on that evidence — but the number that matters is from an
iPhone, not a laptop.

### ADR-002: local prediction without world rollback — a deviation

**PRD 6.4 says:** deterministic lockstep with client-side input delay of 2–5 ticks, plus
rollback for local input.

**Built instead:** deterministic lockstep where *the relay owns the tick clock*, plus
forward prediction of the local clonk's movement only.

Two changes, each with a reason.

*The relay sequences input.* It emits one bundle per tick containing every player's most
recent input, filling gaps with their last known input. Because that decision is made in
exactly one place, every client consumes byte-identical bundles and determinism survives
jitter without clients having to agree on an input-delay negotiation. The cost is that
input latency is RTT-shaped rather than fixed; prediction covers it.

*Prediction replays movement, not the world.* Rolling the world back per frame is not
affordable: the material grid is 512 kB and snapshotting it per tick would cost more than
the entire frame budget. So `src/game/predict.ts` saves the local clonk's entity fields,
replays `moveClonk` — the same code, the same fixed-point maths — forward by the measured
latency, reads the position, and restores. Nothing else in the world is touched.

The consequence is honest and worth stating: **walking, jumping and climbing feel
immediate; the world's response to digging arrives one round trip later.** That is the
real trade for a mutable-terrain lockstep game, and it is why the dig brush is generous
and the dig probe reaches ahead — the mechanic is designed to tolerate the delay rather
than pretend it is not there.

### ADR-003: no React, not even for menus — a small deviation

PRD 6.2 allows React for lobby and menu screens. Three screens did not justify the
dependency: the whole client is 23 kB gzipped, which is a large part of why
time-to-first-round is dominated by network RTT rather than download. Menus are plain DOM
in `src/ui/`. If the lobby grows real complexity, add React then.

### ADR-004: original art in the Clonk idiom, not Clonk's art

The brief is that it should look and play like Clonk Planet. There is a hard line in the
way, and it is worth stating plainly: **Clonk Planet's graphics, sounds and music belong
to RedWolf Design.** Freeware distribution is not a free licence (PRD 3.2), so those files
cannot be shipped here under any name.

What is available: game mechanics are not copyrightable, so they can be reimplemented
freely, and OpenClonk's own sprites are CC-BY / CC-BY-SA and could be dropped in later.

So this build takes the third road. Every sprite is drawn procedurally in
`src/render/atlas.ts` and every material texture is generated in the terrain shader, all
of it original work in the Clonk visual idiom. No audio files either - every sound is
synthesised in `src/audio/audio.ts`.

Three things do the work of making a cell grid look like Clonk's terrain rather than like
coloured squares, and they are worth naming because each was a deliberate fix:

1. **Detail finer than the grid.** Material *selection* is per cell, but texture is
   generated from a continuous world coordinate at three samples per cell. Without this,
   every cell is one flat colour and the ground reads as a mosaic - which is exactly what
   the first version looked like. Earth now has strata, grit and stones set into it; rock
   has quantised facets and hairline cracks; gold is nuggets sitting in rock rather than a
   solid yellow block; wood has grain.
2. **Chiselled edges.** A smoothed coverage field over the neighbouring cells gives a
   surface gradient that is lit directionally, plus an explicit bright rim on top faces, a
   dark rim under overhangs, and a contact shadow falling into the air below a ledge. That
   is what turns stair-stepped cell boundaries into carved rock.
3. **Real light.** Point lights with quadratic falloff: the clonk's own lamp, a furnace
   mouth flickering, a burning fuse, the afterglow of a blast. A cave lit only by what you
   carried into it is most of Clonk's atmosphere underground.

A second pass took the look from Clonk Planet's era towards Clonk Rage's:

4. **Antialiased silhouettes.** The same coverage field that drives the relief also decides
   how much of a pixel is solid, and the material is blended against the background across
   that transition. Terrain outlines became smooth curves instead of the stair-steps of the
   underlying cell grid - the difference between a tile map and a landscape. Water surfaces
   and tree canopies get the same treatment.
5. **Bloom, vignette and a colour grade.** The scene renders to an offscreen target and is
   composited in one sixteen-tap pass that glows anything bright - a furnace mouth, a fuse,
   an explosion, sunlit gold - darkens the corners and lifts contrast slightly. Glow around
   light sources is a large part of why OpenClonk reads as a lit world rather than as
   coloured tiles. The threshold is tuned above the daylit sky: lower, and the sky blooms
   into itself and the whole image goes hazy.
6. **Relief with a specular glint**, from the coverage gradient treated as a surface normal,
   stronger on rock than on soil.
7. **Contact shadows** under every entity, so sprites stand on the terrain instead of
   looking pasted onto it.
8. **Volume in the sprites.** Gradient and radial shading rather than flat fills, which the
   3x authoring resolution is high enough to carry.

A third pass closed the remaining gaps against OpenClonk:

9. **A background material layer.** The landscape as generated, before anyone dug, is kept
   in a second texture and drawn behind open space. A tunnel therefore shows the earth it
   was cut through instead of a void - and because a natural cavern was already empty when
   the island was made, it has no background and stays a dark opening. Caves and tunnels
   read differently without the simulation tracking the difference. This is how Clonk has
   always drawn background material, and it is the single detail that stops a dug tunnel
   from looking like a hole in a tile map.
10. **Translucent water.** A cell holds one material, so there is nothing "behind" water to
    see - except the background layer, which is exactly what was there before. Water is now
    blended over it, with a depth gradient from its own surface and caustic banding.
11. **Cast sun shadows.** Marched towards the light for a few dozen cells, near the surface
    only. Trees shade the ground, hills shade their valleys.

Foliage was redrawn at the same time: distinct leaf clusters with lit tops, dark pockets and
gaps for the sky, instead of a uniform green fog.

### The landscape stopped being a heightmap

The largest single change, and the one that had nothing to do with shading: the generator
used to compute one surface height per column. **A heightmap cannot produce an overhang, an
arch or a vertical cliff face**, because by construction every column has exactly one
surface — and Clonk's landscapes are full of all three. The island is now carved from a
two-dimensional density field, with a cave system cut from the zero set of a second field
(thresholding on the absolute value of noise carves connected tunnels rather than
disconnected bubbles; scaling x harder than y turns the same trick vertical and gives the
chasms that drop out of a hillside).

Two things had to be tuned back after the first attempt, both visible immediately:

- With the sea level where it was, the cave network connected everything below the waterline
  to the ocean and **the entire underground flooded**. The land and sea levels are now far
  apart, which leaves a deep dry interior to tunnel through — while a tunnel dug below the
  waterline still floods, which is the point.
- The first cave thresholds turned the rock into a honeycomb. Clonk's underground is mostly
  solid, with caverns and shafts as events rather than as the default state.

Generation stayed inside the PRD's 500 ms budget only after three rounds of optimisation:
the noise is evaluated on a lattice every third cell and interpolated, the four cave fields
are folded into one so the carving loop takes a single sample per cell, the inner loop
advances the lattice index by hand instead of dividing, and the flood fill stopped
allocating a closure per iteration. From 2.2 s to under the budget.

Sprites are authored at **three atlas pixels per world pixel** and drawn back down at a
third scale, which is the same relationship Clonk has between its sprites and its material
map. At the zoom the game plays at one world pixel covers about four screen pixels, so a
sprite drawn one-to-one with the world can only ever be a mosaic; at 3x, a figure eleven
world pixels tall can have a hat with a brim, a belt, boots and a face. The foundry gets
plank lines, a stone footing, a window and a lit arched furnace mouth. Grass grows as
individual blades that sway, drawn in the shader above the soil line.

Consequences:

- The CC-BY-SA contamination risk (R6) is exactly zero, and the PRD 3.3 audit has nothing
  to audit. `ASSETS.csv` is populated and real; the moment a third-party file enters the
  repo it goes in that file first.
- Swapping in OpenClonk's sprites later touches one file.
- The art is the weakest part of the build and the easiest to improve. It is no longer a
  grey box, but a real artist would replace all of it.

---

## How determinism is enforced

Three independent mechanisms, because a single float in `src/sim` produces rare desyncs
that are miserable to debug (PRD R3).

1. **A lint gate.** `npm run check:sim` fails the build on `Math.random`, any wall-clock
   read, any non-exact `Math.*` function, floating point literals, the `/` operator, or an
   import from outside `src/sim`, `src/fx` and `src/data`. `src/fx` is the one audited
   exception: every operation in it is exact integer arithmetic.
2. **A CI harness.** `npm run check:determinism` bundles the simulation, runs the same
   seed and the same scripted input log on two independent worker threads for 10 000 ticks,
   and compares an FNV-1a hash of the full state every 100 ticks. Any divergence fails.
   It also prints ms/tick, which is how the PRD 6.5 budget gets tracked.
3. **In-round hash exchange.** Clients send a state hash every 30 ticks. The relay
   compares them and, on mismatch, reports *which half broke*: clients also send a rolling
   hash of the input bundles they have consumed, so the log says either "input streams
   AGREE, so this is a simulation divergence" (a bug in `src/sim`) or "input streams
   DIFFER, so this is a transport problem". Guessing which one it is used to be the
   expensive part of debugging a desync.

Recovery: the host serialises the full world (RLE material grid, entities, *and the
pending-material work queue* — two peers with identical material but different work queues
diverge within a few ticks), the relay forwards it and replays the bundles the recovering
client missed. Verified end-to-end by corrupting a client's memory mid-round: detected
within 26 ticks, and the game continues correctly.

Known rough edge: recovery currently costs two snapshot round trips rather than one, due
to a race between applying a snapshot and the replayed bundles arriving. It converges in
about a second and the trigger is a path that should never fire. Worth tidying, not worth
blocking on.

## Also unverified

The service worker could not be registered inside the embedded preview browser used
during development: the script is served correctly (200, `text/javascript`, fetchable) but
registration fails with a generic error, most likely a sandbox restriction rather than a
fault in the build. **The offline shell and the home-screen install therefore need a check
in real Safari and Chrome.** One real bug did surface while looking into it: the relay was
serving `sw.js` with a one-year immutable cache header, which pins a service worker in the
browser for a year and strands installed clients on an old build. Fixed - and observed
first-hand, because the poisoned entry survived in the dev browser's cache afterwards.

---

## Deploying

Two pieces, two hosts, and one reason they cannot share one: the game is static files,
the relay is a process that holds WebSocket connections open for fifteen minutes. Vercel
cannot do the second thing - serverless functions do not outlive a request - so the game
goes to Vercel and the relay goes to Render, Fly or any box with Docker. `vercel.json`,
`render.yaml`, `fly.toml` and a `Dockerfile` are all in the repository, and `DEPLOY.md`
has the commands.

To play on a phone without deploying anything, build and run the relay: it serves the
game as well, so both devices on the same wifi need only `http://<lan-address>:8787`. The
one thing that needs real HTTPS is the service worker, so Add to Home Screen and offline
mode wait for the deployed version.

## What makes it feel like Clonk

The mechanics that carry the feeling, rather than the ones that were cheapest to build:

- **A forest you cut down.** Trees are terrain, not objects: a wooden trunk and a canopy
  of leaves stamped into the grid. Chopping is the same verb as digging, leaves are
  walk-through, and the first foundry costs wood - so the forest is on the critical path
  from the first minute.
- **Dynamite, with no building required.** A lit stick with a visible fuse that falls,
  rolls, chains off other charges, blows a ragged crater, throws clonks and chunks, and
  destroys a foundry outright. It costs coal and wood, both available before anything is
  built, because PRD 5.3 puts interference at the centre of the game rather than at the
  end of a tech tree.
- **Stakes.** A clonk has health and lungs. It drowns if held under, takes damage landing
  from a height (which is why an elevator is worth its metal), and dies to a blast at
  close range - dropping whatever it was hauling right where it fell. Death is a
  three-second penalty and a new clonk at the flag, not elimination: a round is fifteen
  minutes and watching is worse than a setback.
- **Flags stand.** The flag and the ground under it are blast-proof. Everything else is
  fair game.
- **The lorry.** Carrying one chunk at a time is the right constraint for the first
  minute and the wrong one for the tenth. A lorry is a heavy box you shove along a tunnel;
  it swallows chunks it is parked over and empties itself inside your flag ring, which
  turns a seam you found into a seam you are working.
- **Loam.** One chunk lays a bridge where you point it. A chasm stops being a wall and
  becomes a decision about whether it is worth a loam.
- **Fighting without a weapon.** Every clonk already carries a steel blade, so the shovel
  swings at whoever is in front; a chunk thrown hard enough hurts whoever it lands on. The
  lobby picks whether the round is settled by gold or by kills.
- **Bots.** Empty slots fill themselves. They are computed from world state on every
  client rather than sent over the wire, so they are deterministic, cost no bandwidth, and
  mean there is always a round to start - which is the answer to risk R9.

Deliberately still absent: vehicles, ranged weapons, the knowledge/construction-site
system, loam, melee mode. Those are PRD 4.2 territory, not MVP.

## Layout

```
src/fx/        Q16.16 fixed point. Imports nothing. The audited exception to the no-float rule.
src/data/      Tunables and material tables. Imports nothing.
src/sim/       The simulation. Imports only fx and data. No floats, no clocks, no randomness.
  grid.ts        material grid, falling material, water flow, structural collapse
  clonk.ts       movement, digging, carrying, depositing
  physics.ts     AABB against the grid
  gen.ts         seeded island generator
  sim.ts         tick orchestration and win conditions
  hash.ts        FNV-1a state hash
  snapshot.ts    full-state serialisation for resync
  headless.ts    entry point for the CI determinism harness
src/render/    WebGL2. One shader for the material grid, one batch for sprites.
src/input/     Touch controls (and keyboard, for development only).
src/net/       Lockstep driver, wire protocol, relay client.
src/game/      Frame loop and local prediction.
src/ui/        Menu, lobby, in-game HUD. Plain DOM.
server/        The relay. One file, no database.
scripts/       Determinism harness, purity gate, bundle budget.
tests/         42 tests: fixed point, grid physics, core loop, determinism, lockstep.
```

The import boundary around `src/sim` is enforced, not merely intended.

---

## The gate this build has not passed

PRD 8.1 makes the control scheme the kill-or-continue question, and PRD 5.2 states the
gate precisely:

> if a first-time player cannot dig a tunnel, find coal, and return to base within
> 3 minutes of first launch without instruction, the control scheme has failed and the
> project pauses on engine work until it is fixed.

**That test has not been run.** Everything in this repo is engine work, which the PRD
explicitly says should not continue past a failed control gate. The next action is not
more features: it is three people, three phones, and a stopwatch.

Two things were tuned during the build that directly affect that test, and both are
guesses until a thumb touches them:

- The dig brush is deliberately much larger than the clonk (13 px versus a 7 × 11 body).
  An earlier version had a brush narrower than the clonk, which meant a dug shaft was too
  narrow to fall into and a dug tunnel too low to walk through. Generous tunnels also
  absorb the prediction delay from ADR-002.
- Digging follows the movement stick with no separate aim input, as PRD 5.2 proposes, and
  the dig probe reaches up to 10 px ahead so aiming is forgiving. Whether that survives
  contact with a real thumb is open question Q2.

## Open questions from the PRD

| # | Question | Status |
|---|---|---|
| Q1 | Ship name | Provisionally **Undermine**. Yours to confirm. |
| Q2 | Stick-directed digging, or a separate aim gesture? | Both. Stick-directed on touch, mouse-aimed on desktop, via a separate aim channel in the input frame. The touch half is still unvalidated on a real thumb. |
| Q3 | Is 1024 × 512 the right grid? | Implemented at 1024 × 512, in `src/data/config.ts` as a single constant so it is cheap to change. Unvalidated. |
| Q4 | Teams or free-for-all? | Both. The lobby toggles 2 teams / 4 teams / free-for-all; the simulation is parameterised. Defaults to 2. |
| Q5 | Is the OpenClonk sprite set legible at phone size? | Not answered — no OpenClonk sprites are used yet (ADR-004). |
| Q6 | Public repo from day one? | Yours to decide. Nothing in the code assumes either. |
| Q7 | Spike a WASM grid module? | Recommend **no for now**: a fraction of a millisecond per tick against a 12 ms budget. Revisit with an iPhone number. |

## Attribution

> Inspired by the Clonk series by RedWolf Design. Not affiliated with or endorsed by
> RedWolf Design.

The word "Clonk" appears in this repository's internal documentation and in that single
attribution line only — never in the product name, the icon, the manifest or any store
metadata (PRD 3.2). No Clonk or OpenClonk assets are currently bundled; see `ASSETS.csv`.

## Licence

Engine code: ISC, matching the OpenClonk engine this project takes its design from.
See `LICENSE`.
