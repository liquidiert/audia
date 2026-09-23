# audia

Crowd-voted playlists for parties. Phones search YouTube Music and vote for songs.
Votes sync peer to peer over [iroh-gossip](https://docs.iroh.computer/connecting/gossip),
which runs **in the browser** through WebAssembly. A big-screen display shows the live vote
as three.js bubbles and the currently playing song in a pill with a seekbar.

```
phone (wasm iroh-gossip) ◄──relay──► phone ◄──relay──► /display (wasm peer, three.js)
          │                                                   │
          └──────── Bun: static pages, /api/search, session directory ───────┘
```

## Quick start

```sh
bun install
bun run dev          # or: bun run start (production mode)
```

1. Open `http://localhost:3000/display` on the big screen and log in (see
   [Display password](#display-password)). This starts a session.
2. Scan the QR code with phones. The voting page is only reachable through that code
   (see [Joining](#joining)).
3. Search, tap **+** to propose a song and vote for it, and tap **♥** to vote or unvote.
   Tap the skip button in the now-playing bar to vote to skip the current song.
4. On the display, click **♪ Enable sound** to play the schedule through the YouTube player.
   Optionally click **Base playlist** and paste a YouTube Music playlist link: when nobody votes,
   random songs from it keep the music going.
5. When the party is over, click **End session** on the display. Voting stops, the music ends,
   and phones show what was played. Then click **Save playlist to YouTube Music**. See
   [Saving playlists](#saving-playlists-to-youtube-music) for the one-time setup.

Press **P**, or click the arrow in the top-right corner, to hide or show the display's side panel.
Only the browser that started a session can end it, because its iroh key signs the end event.

Session parameters are query params on a new session:
`/display?new&name=Party&round=90&votes=3&queue=3&skip=5`

| param   | default | meaning                                                             |
| ------- | ------- | ------------------------------------------------------------------- |
| `round` | 90      | Round length in seconds.                                            |
| `votes` | 3       | Votes per person that count at once. A newer vote pushes out the oldest. |
| `queue` | 3       | Rounds pause, and votes keep rolling, while this many songs are queued or playing. |
| `skip`  | 5       | Skip votes from different people that end the current song early. |

Env:

| variable                | meaning                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `PORT`                  | Port to listen on (default 3000).                                    |
| `DISPLAY_USER`          | Basic auth user for the display (default `audia`).                   |
| `DISPLAY_PASSWORD_HASH` | Salted password hash for the display. Generate it with `bun run hash-password`. |
| `GOOGLE_CLIENT_ID`      | Optional. Enables saving playlists to YouTube.                       |
| `AUDIA_SESSION_FILE`    | Where the current session is kept (default `.audia-session.json`).   |

## Joining

Guests can only reach the voting page by scanning the display's QR code. Each session has a
random join token, and the QR code points at `/join/<token>`. That link sets an HttpOnly cookie
and redirects to the voting page. The page and the phone APIs (session lookup, search, peer
heartbeat) require the cookie, and everyone else gets a "scan the QR code" page.

Starting a new session or ending the current one creates or voids the token, so old QR codes
and cookies stop working. The display itself gets in with its password. Without
`DISPLAY_PASSWORD_HASH` nothing is protected, which keeps local development setup-free.

## Base playlist

Click **Base playlist** on the display and paste a YouTube Music (or YouTube) playlist link.
Public and unlisted playlists work; auto-generated charts and radio mixes can't be read.

- When a round closes without a voted song and the music would stop before the next round,
  a random song from the base playlist is queued instead. A song with even one vote always wins.
- **Song order** (in the same dialog): *Shuffle* (default) picks a random song that every peer
  agrees on, because it's seeded by session and round, and avoids repeats until the whole list
  has had its turn. *Playlist order* plays the song after the last base song and wraps around
  at the end.
- Base songs show an "auto" tag. Only the display that started the session can set or remove
  the base playlist, which holds up to 400 songs.
- The saved playlist and the phones' "Played tonight" list contain only songs that actually
  started playing, both voted and base, minus skipped songs.

## Display password

`/display` and the endpoints only it uses (`/api/info`, `/api/playlist`, `/api/display/*`,
and changing or ending the session) are protected with HTTP Basic auth. Phones get in through
the QR code instead (see [Joining](#joining)).

The password is never stored in plain text. Generate a salted argon2id hash and put it in the environment:

```sh
bun run hash-password          # prompts for the password
# DISPLAY_PASSWORD_HASH=JGFyZ29uMmlk…
```

The script prints the hash base64-encoded, because raw hashes contain `$`, which `.env` files
and deploy dashboards tend to interpolate. Raw `$argon2id$…` values are accepted too. If the
variable is missing, the server logs a warning and the display is open to everyone.

After 10 failed logins in 10 minutes from one client (by `X-Forwarded-For`), the server
answers 429 until the window has passed.

## Saving playlists to YouTube Music

The display saves every song that actually played, in play order and without skipped songs,
as a new playlist in the signed-in Google account. It shows up in both YouTube and YouTube Music.
Sign-in happens entirely in the browser (Google Identity Services), and the server only knows
the public client ID.

One-time setup in the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project and enable **YouTube Data API v3**.
2. Configure the **OAuth consent screen**. While it's in *Testing*, add the Google accounts that
   will save playlists as test users.
3. Create an **OAuth client ID** of type *Web application*. Under **Authorized JavaScript origins**,
   add the site's origin, e.g. `https://audia.example.com`, plus `http://localhost:3000` for development.
4. Set `GOOGLE_CLIENT_ID` to the client ID (`….apps.googleusercontent.com`) and restart.

Without `GOOGLE_CLIENT_ID`, the dialog offers a link that opens the songs as a temporary
YouTube playlist, which can be saved there with **Save**. YouTube limits that link to 50 songs.

The API's default quota is 10,000 units a day, and each song costs 50, so one day's quota
saves about 190 songs.

## How it works

**Networking** (`crates/audia-gossip`): a small Rust crate that wraps `iroh` 1.x and
`iroh-gossip` with `wasm-bindgen`. Each browser tab is an iroh endpoint that joins one gossip
topic. Browsers can't use UDP, so traffic goes through iroh relays (n0's public relays by default).
The crate also exposes ed25519 `sign` and `verify`, so every event is signed with the author's
endpoint key and nobody can vote under someone else's id.

**Replicated event log** (`src/client/session.ts`): peers exchange signed `propose`, `vote`,
`skip`, `base` and `end` events. When a neighbour comes up, each side sends its full log in chunks, so late joiners and
reloaded phones catch up. The log is also kept in `localStorage`. The Bun host keeps a
directory of recently seen peers (`/api/session`), and a peer with no neighbours keeps
re-dialling fresh ones.

**Rolling rounds** (`src/shared/state.ts`, unit-tested): every peer derives the same state from
the same log, so there is no leader.

- Round *r* ends at `epoch + (r+1)·roundMs` and is finalised after a short grace period.
- The song with the most votes joins the playlist. Ties go to the earlier proposal.
- The winner's votes are used up. Votes on songs that lost roll over into the next round.
- A person's latest vote per song wins, and only their `maxVotes` most recent votes count.
- Songs play back to back: `startAt = max(closedAt, previous endAt)`. "Now playing" and the
  seekbar position are computed from this schedule on every device.
- A skip vote counts only while its song is playing. When `skip` different people have voted,
  the song ends at the moment of the last vote and the rest of the playlist moves up.
- If nobody voted and the queue would run dry, a seeded-random base playlist song fills the gap.

**Search** (`src/server.ts`): YouTube Music has no official public API. The server proxies
`/api/search` through [`ytmusic-api`](https://www.npmjs.com/package/ytmusic-api), the unofficial
InnerTube API, because browsers can't call it directly (CORS).

## Development

```sh
bun test                 # reducer, protocol, auth, join token and YouTube client tests
bun run typecheck
bun run build:wasm       # rebuild src/wasm/ from crates/audia-gossip
```

The generated bindings in `src/wasm/` are committed, so running the app needs only Bun.
Rebuilding them needs:

- Rust with the `wasm32-unknown-unknown` target
- `clang`, because `ring` compiles C for wasm
- `wasm-bindgen-cli` at the same version as the `wasm-bindgen` crate (currently 0.2.128)
- `wasm-opt`, optional, to shrink the output

## Caveats

- Voter ids are per-browser keys, so someone can clear storage to get a new identity. Votes
  are authenticated, but there's no protection against one person using many identities.
- Round closing uses device clocks. Clients correct for the offset against the serving host's
  clock, but a device with a badly wrong clock can still get votes counted in the wrong round.
- Some tracks can't be embedded on YouTube. The display marks them and the schedule continues.
- Phones that lock their screen leave the swarm. When they come back, they sync the full log again.
