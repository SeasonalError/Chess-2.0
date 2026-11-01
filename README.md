# Riftbound · Chess 2.0

**[Play Riftbound](https://riftbound-chess-arena.nimeesh16-2007.chatgpt.site/)**

Riftbound is a chess variant with a private wildcard draft, six hidden techniques, a ten-second tap duel, a tactical bot and two-player rooms. Win by checkmate.

## Start a duel

- **Play solo.** The arena opens with you playing White against The Oracle on Apex. Choose **New duel** to change sides or difficulty. Refreshing the page resumes your solo game.
- **Play a friend.** Choose **Play a friend → Create room → Copy link**. Your friend opens the link and chooses **Join room**. The host plays White and the guest plays Black. You can reconnect from the same browser, or type the room code to join.
- **Draft your wildcard.** Both players see the same six cards and secretly lock one before White moves. The same card can be picked by both players. Saved games from earlier versions finish under their original rules.
- **Use a technique.** Select a technique in the Technique deck, choose **Arm technique**, then select a highlighted piece and destination. Choose the king’s own square to cast Domain Expansion. Arrow keys and Enter also work on the board. Your opponent sees a sealed cast. They can predict its target square before the technique is revealed.

## The wildcard draft

Your card is yours to play once. It takes your entire turn, costs no charges, and cannot be played while you are in check. A wildcard resolves immediately. Charged techniques still give the defender their usual prediction window. If your technique is on cooldown, you still owe an ordinary move after using a wildcard.

| Wildcard | What happens on the board |
| --- | --- |
| **Kamui Rift** | Send a friendly or enemy non-king into another dimension. Its square stays empty and reserved. Sliding pieces can see through it. The displaced piece returns to that square after the next two individual turns, one by each player. |
| **Noble Protection** | Ward one friendly non-king for the rest of its life. Enemy charged attacks and hostile wildcards cannot target it. An ordinary chess capture still takes it. |
| **Power Trade** | Privately exchange the charged techniques of two friendly pieces of different types. The pair keep their ordinary moves and carry the exchange with them. Used techniques stay spent. A king can trade, but cannot stake itself in a borrowed Royal Tribunal. |
| **Absolute Zero** | Freeze an enemy non-king for its next turn. It cannot move or cast. It still attacks its usual squares, so a frozen rook still guards its file. |
| **Repulse** | Use a friendly non-king to shove an adjacent enemy non-king one square directly away, into an empty square. The shoving piece stays put. |
| **Relay** | Exchange the positions of two adjacent friendly non-kings. Both pieces keep their identities. Neither Relay nor Repulse may put a pawn on either back rank. |

**Try the pawn trick with a friend.** As White, draft Power Trade and exchange the pawn on **b2** with the bishop on **c1**. Have Black play **a7–a6**. Arm **Phase Lance** on the pawn. It can reach the **h8 rook** through the **g7 pawn**. If Black lets the cast through, the rook falls and your pawn snaps back to **b2**. Ordinary pawn moves to the back rank still promote. Your opponent sees that Power Trade was played, but the identity of the two pieces stays secret.

## The mind game

Both players start with **two counter attempts**. When your opponent commits a technique, you see the board as it stood before the cast. You have 15 seconds to predict one square. Read the threats, then decide whether to risk a counter.

- A correct square cancels the cast. The caster still spends the charges, the technique and the turn.
- An incorrect square spends your counter and lets the cast go through. Passing or letting the timer expire saves your counter.
- When you have no counters left, the opponent’s technique goes through immediately.

**Royal Tribunal** traps the queen and one enemy piece on the same rank or file, up to four squares apart. Pieces between them offer no cover. If the defender lets the challenge through, both players get ten seconds to tap. More taps for the queen removes the target. Fewer taps or a tie removes the queen. The surviving piece stays on its square. A king is never a legal target.

Try it with a friend. Play **1. e3 d5**, arm the white queen on **d1** and target the black pawn on **d5** through your own pawn on d2. Black can predict **d5** to cancel the challenge, or let it through and fight for the chance to take a queen with a pawn.

## Rules

Each player gets **three charges for the entire match**. Each of the six techniques may be cast once per side, shared across the original and traded holders of that technique. A cast uses the entire turn. After casting, that side must play a normal move before casting again.

| Piece | Technique | Charges | Move |
| --- | --- | --- | --- |
| Pawn | Vector Step | 1 | Move one file sideways into an empty square. Doing this on the starting rank forfeits the pawn’s initial double step. |
| Knight | Rift Jump | 1 | Teleport exactly two squares horizontally or vertically into an empty square. |
| Bishop | Phase Lance | 1 | Cross exactly one intervening piece diagonally. Land beyond it on an empty square or capture the first enemy beyond it. |
| Rook | Aegis | 1 | Shield another friendly non-king piece one to three squares away along a rank or file, even through blockers. It cannot be captured on the next enemy reply. |
| Queen | Royal Tribunal | 2 | Challenge an enemy non-king up to four squares away on a rank or file, even through blockers. The losing piece is removed. Ties favor the defender. |
| King | Domain Expansion | 2 | Stay in place and seal the eight neighboring squares against enemy landings for their next turn. Casting preserves castling rights. |

Ordinary chess attacks determine check. Respond to check with an ordinary chess move. You may cast only if your king is safe, including after either outcome of a Royal Tribunal. Castling, en passant and all four promotions are supported. Stalemate, threefold repetition, the fifty-move rule and insufficient material draw automatically. Repetition accounts for techniques, resources, counter attempts, shields and the active domain.

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

- `public/game/engine.js` defines the rules for the board, bot and server. Tests cover standard chess move counts, techniques, wildcards, king safety and draws.
- `public/game/bot.js` searches standard moves and techniques together using iterative deepening, alpha-beta search, a transposition table and tactical quiescence. Apex has a 3.6-second search budget in a browser worker. Tests cover teleport mate, defending against teleport mate, a Phase Lance capture and underpromotion. The bot has no established Elo rating.
- `public/game/encounter.js` handles cast commitments, counter windows and shared duel clocks. The room server keeps the committed move private until the reveal.
- `lib/rooms.js` owns seats and validates every move against the current position. Revision checks handle competing moves. The invitation contains a room code. Seat credentials stay in each player’s browser and are stored as hashes on the server.
- `public/art/` contains the original vector chessmen, portraits and interface icons.
