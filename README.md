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

1. Open `http://localhost:3000/display` on the big screen. This starts a session.
2. Scan the QR code with phones. They open the voting page (`/`) on the host's LAN address.
3. Search, tap **+** to propose a song and vote for it, and tap **♥** to vote or unvote.
4. On the display, click **♪ Enable sound** to play the schedule through the YouTube player.

Session parameters are query params on a new session:
`/display?new&name=Party&round=90&votes=3&queue=3`

| param   | default | meaning                                                             |
| ------- | ------- | ------------------------------------------------------------------- |
| `round` | 90      | Round length in seconds.                                            |
| `votes` | 3       | Votes per person that count at once. A newer vote pushes out the oldest. |
| `queue` | 3       | Rounds pause, and votes keep rolling, while this many songs are queued or playing. |

Env: `PORT` (default 3000), `AUDIA_SESSION_FILE` (default `.audia-session.json`).

## How it works

**Networking** (`crates/audia-gossip`): a small Rust crate that wraps `iroh` 1.x and
`iroh-gossip` with `wasm-bindgen`. Each browser tab is an iroh endpoint that joins one gossip
topic. Browsers can't use UDP, so traffic goes through iroh relays (n0's public relays by default).
The crate also exposes ed25519 `sign` and `verify`, so every event is signed with the author's
endpoint key and nobody can vote under someone else's id.

**Replicated event log** (`src/client/session.ts`): peers exchange signed `propose` and `vote`
events. When a neighbour comes up, each side sends its full log in chunks, so late joiners and
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

**Search** (`src/server.ts`): YouTube Music has no official public API. The server proxies
`/api/search` through [`ytmusic-api`](https://www.npmjs.com/package/ytmusic-api), the unofficial
InnerTube API, because browsers can't call it directly (CORS).

## Development

```sh
bun test                 # reducer + protocol tests
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
