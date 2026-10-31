# Riftbound · Chess 2.0

**[Play Riftbound](https://riftbound-chess-arena.nimeesh16-2007.chatgpt.site/)**

Riftbound is a chess variant with six anime-inspired techniques, a tactical bot and private two-player rooms. Win by checkmate.

## Start a duel

- **Play solo.** The arena opens with you playing White against The Oracle on Apex. Choose **New duel** to change sides or difficulty. Refreshing the page resumes your solo game.
- **Play a friend.** Choose **Play a friend → Create room → Copy link**. Your friend opens the link and chooses **Join room**. The host plays White and the guest plays Black. You can reconnect from the same browser, or type the room code to join.
- **Use a technique.** Select a piece type in the Technique deck, choose **Arm technique**, then select a highlighted piece and destination. Choose the king’s own square to cast Domain Expansion. Arrow keys and Enter also work on the board.

## Rules

Each player gets **three charges for the entire match**. Each piece type may cast once per side, shared across all pieces of that type. A cast uses the entire turn. After casting, that side must play a normal move before casting again.

| Piece | Technique | Charges | Move |
| --- | --- | --- | --- |
| Pawn | Vector Step | 1 | Move one file sideways into an empty square. Doing this on the starting rank forfeits the pawn’s initial double step. |
| Knight | Rift Jump | 1 | Teleport exactly two squares horizontally or vertically into an empty square. |
| Bishop | Phase Lance | 1 | Cross exactly one intervening piece diagonally. Land beyond it on an empty square or capture the first enemy beyond it. |
| Rook | Iron Vault | 1 | Vault the first friendly piece in a straight line and land on the empty square immediately behind it. |
| Queen | Mirror Step | 1 | Teleport exactly two squares diagonally into an empty square, ignoring blockers. |
| King | Domain Expansion | 2 | Stay in place and seal the eight neighboring squares against enemy landings for their next turn. Casting preserves castling rights. |

Ordinary chess attacks determine check. A technique may escape check but must leave your king safe. Castling, en passant and all four promotions are supported. Stalemate, threefold repetition, the fifty-move rule and insufficient material draw automatically. Repetition accounts for techniques, resources and the active domain.

## Run locally

Use Node.js 22.13 or newer. The standalone server needs no package installation.

```sh
git clone https://github.com/SeasonalError/Chess-2.0.git
cd Chess-2.0
node server.mjs
```

Open `http://localhost:3000`. On the same Wi-Fi, both players can use the host computer’s LAN address on port 3000. For internet play, use the hosted arena or deploy this server on an HTTPS-capable host. Generate the invite from the address your friend can reach.

The server accepts `HOST`, `PORT` and `ROOM_DB`. Rooms persist in `data/rooms.sqlite` by default. Mount that path on persistent storage when self-hosting. The hosted Worker runs the same room handler with D1.

## Engine and tests

```sh
node --test tests/*.test.mjs
```

- `public/game/engine.js` defines the rules for the board, bot and server. Tests cover standard chess move counts, all six techniques, king safety and draws.
- `public/game/bot.js` searches standard moves and techniques together using iterative deepening, alpha-beta search, a transposition table and tactical quiescence. Apex has a 3.6-second search budget in a browser worker. Tests cover teleport mate, defending against teleport mate, a Phase Lance capture and underpromotion. The bot has no established Elo rating.
- `lib/rooms.js` owns seats and validates every move against the current position. Revision checks handle competing moves. The invitation contains a room code. Seat credentials stay in each player’s browser and are stored as hashes on the server.
- `public/art/` contains the original vector chessmen, portraits and interface icons.
