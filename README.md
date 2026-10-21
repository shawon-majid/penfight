# Pen Fight

Flick your pen, knock everyone else off the table. Last pen standing wins.

Up to ten people on one table, joined with a five-character code, taking it in
turns. On your own, you play four-handed against three bots. Plays on a phone
as well as a laptop.

Who goes first is drawn at random, then play goes round the table. The first
lap is an **opening round**: a pen knocked off by somebody else's shot is put
back on its starting spot, so everyone gets at least one go before anyone can
be knocked out. Sending your *own* pen off still knocks you out, even then.

The interesting part is the physics. A pen is not a ball — it is a long thing
with an orientation, so *where* you hit it matters as much as how hard. Grab it
through the middle and it slides straight. Grab a tip and the same flick puts
most of its energy into spin: it wheels away, sweeps a much wider path, and
travels noticeably further, because the table's grip has to be shared between
stopping the slide and stopping the spin. All of that falls out of the
simulation rather than being scripted.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:5173 — solo play needs nothing else
```

Solo mode runs entirely in the browser, so `pnpm dev` on its own is enough for
playing, and for any work on the physics or the rules.

For online tables, run the server alongside it in a second terminal:

```bash
pnpm dev:server   # the Cloudflare Worker on :8787; Vite proxies /api to it
```

Other commands:

```bash
pnpm test         # the physics, the rules, and the balance checks
pnpm typecheck    # browser code and Worker code are checked separately
pnpm build        # typecheck, then build the site into dist/
pnpm deploy       # build, then push to Cloudflare
```

Deploying needs a Cloudflare account (`npx wrangler login`). The free plan
covers this comfortably — the game uses Workers and one SQLite-backed Durable
Object per table.

## How the code is laid out

```
src/
  shared/          runs identically in the browser and on the server
    physics/       pens, friction, the engine bridge — no DOM, no network
      pens/        the pen catalogue: one entry per kind of pen
    game/          rules: turns, elimination, strikes, bots, table codes
    net/            the wire format and snapshots
  client/          browser only
    render/        canvas drawing
    input/         the flick gesture
    ui/            lobby and heads-up display
    modes/         solo and online sessions behind one interface
  server/          Cloudflare Worker + one Durable Object per table
supabase/          database schema for accounts and results
tests/             covers src/shared, plus the viewport maths
```

The split that matters is `shared/physics` ← `shared/game` ← everything else.
Physics knows about pens on a rectangle and nothing else. The rules know about
players and turns but not about how a pen moves. The client knows about both
but neither knows about it. So you can retune the feel without touching the
rules, change the rules without touching the solver, and replace the renderer
without touching either.

### Where to change things

| You want to… | Go to |
| --- | --- |
| Add a pen, or change one — size, weight, grip, bounce | `shared/physics/pens/catalogue.ts` |
| Change how the game feels for every pen — shot power, timestep | `shared/physics/tuning.ts` |
| Resize the table or move the starting positions | `shared/physics/table.ts` |
| Change the rules — lives, teams, more pens each | `shared/game/match.ts` |
| Change how a flick becomes an impulse | `shared/game/strike.ts` |
| Make the bots think differently | `shared/game/bots.ts` (`rateStrike`) |
| Change how it looks | `client/render/` |
| Change the gesture | `client/input/aim.ts` |

Every feel-related number lives in `tuning.ts` (the same for every pen) or in a
pen's entry in `pens/catalogue.ts` (that pen only), each with a comment
explaining what it does. All of them are physical quantities in real units.

## How the physics works

The rigid-body physics is done by [Planck.js](https://github.com/piqnt/planck.js),
a JavaScript port of Box2D. The game keeps its own plain pen data as the source
of truth and hands it to Planck each step (`physics/engine.ts`), so nothing
outside `physics/` knows Planck exists.

**A pen is a real shape**: a barrel with a pointed or rounded tip and a round or
flat cap, from its catalogue entry. Its centre of mass can sit off the middle —
a marker's heavy cap pulls it towards the back — and its moment of inertia is
worked out from its shape, never typed in.

**A flick sets the speed of your finger**, not a fixed shove. The point you
grab is brought up to finger speed, so the impulse is that speed times the mass
the finger meets there: the whole pen through its centre of mass, about a
quarter of it at a tip. A centre flick flies straight; a tip flick wheels away
slowly. A finger is only so strong, so a heavy pen leaves slower but hits
harder. A push along the barrel partly slides off the end and loses some punch.

**Table friction** is applied at eight points along the barrel, with the
pen's weight shared towards its centre of mass. That buys three things you can
see:

- Grip is shared between sliding and spinning, so a spinning pen slides further.
- A round barrel rolls: friction and drag across it are a fraction of what they
  are along it, so a side-on flick goes much further than an end-on one.
- A lopsided pen sliding and spinning is pulled round by its heavy end, so it
  curves slightly.

A speed-proportional drag on top makes range grow nearly in step with flick
speed, so a half-power shot is a real shot.

**Contacts** are Planck's: the exact shapes, two contact points where barrels
meet along their length, a proper solver for a pile of pens, and continuous
collision so a fast pen can never pass through another. The game decides how
two pens' bounciness combines (around 0.7, as hard plastic is).

**Falling off** happens when a pen's centre of mass passes the edge. Overhang
is fine; it is the balance point that decides.

The game advances at a fixed 60 frames a second, with Planck stepping at
120 Hz underneath. It is deterministic: every shot starts on a fresh engine
built from the pens' plain state, so the same starting state and the same shot
produce the same result in every browser, on the server and in a bot's
lookahead — which is what the networking is built on.

## On a phone

The table is a landscape rectangle and a phone held upright is not, so rather
than shrink the table into a letterbox, **the view turns a quarter turn**. The
simulation is untouched and everyone is looking at the same table — it is just
oriented to the screen in front of them. `fitViewport` tries the table both
ways round each frame and keeps whichever comes out bigger, so rotating the
handset just works, with no orientation lock and nothing to configure.

The rest of it:

- **The display never covers the play area.** The heads-up display reports how
  much room it is using and the table is fitted into what is left. Those
  measurements come from the elements themselves, not from CSS breakpoints
  copied into JavaScript, so the two cannot drift apart and leave a pen hidden
  under somebody's name. Player chips run across the top on a phone held
  upright, and down the side when it is held sideways, where the spare space is.
- **Grab tolerance is measured in pixels, not metres.** A mouse is precise at
  any scale; a fingertip covers about a centimetre of glass. Touch devices get
  roughly double the reach around the barrel.
- **The aim guides are drawn heavier on touch**, and the contact spot becomes a
  ring rather than a dot, so it still reads around the edges of a finger.
- **The canvas owns its own gestures** — no scrolling, no pinch-zoom, no
  double-tap-to-zoom, no pull-to-refresh mid-shot, and no text selection when
  you drag.
- **Pixel density is capped at 2.** Phones ship 3x screens; drawing nine times
  the pixels for a difference nobody can see is the quickest way to drop frames
  on the device least able to spare them.
- **"Invite" uses the share sheet** where the browser has one, so a table code
  goes straight into whichever chat the players are already in.
- Heights use `dvh` and everything is padded clear of notches and home
  indicators. Text inputs are 16px, which is what stops iOS zooming the page in
  when you tap the name field.

## How the multiplayer works

Each table code maps to one Durable Object — a single piece of server state
with its own address, so "type this code to join my table" resolves to the same
object anywhere in the world.

Clients only ever send **intent**: "I flicked my pen from here, in this
direction, this hard." Four numbers. They never send pen positions, so a
modified client cannot teleport its pen or claim a kill it did not make.

When a strike arrives, the server checks it against its own copy of the match,
simulates the whole shot to a standstill immediately (a few milliseconds),
broadcasts the strike so every browser starts animating at once, and then sends
the settled state as an authoritative snapshot once the animation would have
finished. Every browser runs the identical solver, so they all show the same
shot without anyone streaming positions sixty times a second — and any drift is
wiped out by the next snapshot rather than accumulating.

A player who drops keeps their seat and their pen. Their turns are skipped
until they return, and their pen is still fair game in the meantime. Turns also
have a 45-second clock, so one person wandering off cannot freeze a ten-person
table.

## Accounts

Signing in is optional. Guests keep everything in the browser — name, pen
colour and games against the bots, in local storage — and never touch
Supabase; its library is not even downloaded until someone presses "Sign in".

Signing in is Google through **Supabase Auth**. The first time, the guest's
name, colour and bot games are copied into the new profile. From then on:

- **Online games are recorded by the server, not the browser.** A signed-in
  browser offers its access token as a websocket subprotocol (browsers cannot
  set headers on a websocket, and this keeps it out of URLs and logs). The
  Worker asks Supabase whose token it is and seats the player as
  `acct:<user id>`; everyone else is `guest:<browser id>`, so a guest can never
  claim an account's seat. When a match ends, the table saves it — every seat,
  guests included — if anyone at it was signed in. All-guest games are not
  saved.
- **Solo games are self-reported**, since solo runs in the browser. The
  database files the one non-bot seat under whoever is signed in, whatever the
  request says, and keeps them apart (`mode = 'solo'`).
- **Stats are computed from the games** (`my_profile_summary()`), so there is
  no running total to drift.

### The database

| Table | One row per | Holds |
| --- | --- | --- |
| `profiles` | signed-in player | name, pen colour, `settings` (JSON) |
| `matches` | finished game | mode, table code or bot difficulty, `ruleset`, turns, times, `details` (JSON) |
| `match_players` | seat in a game | account (if any), kind (`account`/`guest`/`bot`), name at the time, colour, place, won, knock-outs, fell off, `stats` (JSON) |

Built to change without breaking:

- **Only add.** New columns are nullable or have a default. Renames and drops
  go in three steps: add the new one, move the code over, drop the old one in
  a later release.
- **Columns for what you filter or rank by, JSON for experiments.** A new
  number starts in `stats`; promote it to a column once a leaderboard needs it.
- **`ruleset`** records which rules a game was played under. Bump `RULESET` in
  `shared/game/results.ts` when the rules change, so stats can tell them apart.
- **Nobody touches the tables directly.** Browsers and the server go through
  functions — `my_profile_summary`, `my_recent_matches`, `record_solo_matches`,
  and `record_online_match` (secret key only) — so the tables can be reshaped
  behind them without a client release.
- New features are new tables (achievements, pen skins, friends, replays),
  not changes to these.

Every change is a migration in `supabase/migrations/`. Setup:

1. In Supabase → Authentication → Providers, enable **Google** with a client
   ID and secret from a Google Cloud OAuth client.
2. In Supabase → Authentication → URL Configuration, allow the site's
   addresses as redirect URLs (`https://penfight.shawonmajid.com/**`, the
   workers.dev address, and `http://localhost:5173/**`).
3. `npx wrangler secret put SUPABASE_SECRET_KEY` so the deployed server can
   save results. For `pnpm dev:server`, put the same line in `.dev.vars`
   (git-ignored): `SUPABASE_SECRET_KEY=...`.

The project URL and publishable key are public and live in `.env` (browser)
and `wrangler.jsonc` (server).

## Bots

The bot has no hidden knowledge and no special physics. It lines up a handful
of plausible shots, plays each one out in a copy of the world using the real
solver, and takes whichever looked best. Because it rehearses with the actual
simulation, it is automatically right about spin, rebounds and chain reactions,
and it cannot drift out of step as the physics is tuned.

Difficulty is how many shots it gets to consider and how steady its hand is —
not a cheat. `rateStrike` is exported: replace it and you have a different
personality (a spoiler that only defends, a bully that goes after the leader)
without touching the search around it.

## Balance

`tests/balance.test.ts` plays a few hundred bot matches and checks the game is
actually a game. As tuned, four-player bot matches run about **16 turns** on
average (8 to 33), four of them being the opening round, and draws — everybody
falling off together — are rare.

A few relationships hold the tuning together, and the tests enforce them for
every pen in the catalogue:

- A full-power shot that **misses** carries your own pen off the table from the
  middle, but not clean across the long side.
- A **half-power** hit never knocks a pen off from the middle — you have to
  work someone towards an edge, or land a perfect full-power hit.
- A struck pen never travels further than the striker would have on its own.
- Side-on flicks roll further than end-on ones.

Change `maxFlickSpeed`, a pen's grip, or the table size and those tests will
tell you what it did to the game.

## Testing

```bash
pnpm test
```

121 tests over `src/shared` and the pure maths in `client/render/theme.ts`: the
closest-approach maths including its degenerate
cases, momentum conservation through a hit, friction matching `v²/2μg`, spin
transfer, pens never tunnelling through each other at full speed, turn order
and elimination, the random first player and the opening round, final
standings and the win tally, snapshot round-trips, and the balance checks
above. There is no DOM and no network in any of it, which is the point of the
layering.

## Ideas worth adding

The seams are already there for most of these:

- **Lopsided pens** — a heavy cap and a clip, so shots genuinely curve.
  `friction.ts` samples the barrel already; give the samples uneven weights.
- **Different pens** — a stubby marker, a long thin biro. `tuning.ts` is
  per-world today; make it per-pen.
- **More pens each**, or teams. `match.ts` owns the rules; the physics does not
  care how many pens a player has.
- **Replays** — a match is a starting state plus a list of strikes, and the
  solver is deterministic, so a replay is already possible for free.
- **A shrinking table** for long games. `table.ts` is one rectangle.
- **Spectators** — the server already treats latecomers as spectators; they
  just need a viewer.
