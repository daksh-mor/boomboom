# itch.io Page Kit — BoomBoom — Doodle Royale

Paste-ready copy for a free, external open-source game page. **There is currently no hosted public demo:** players clone or download the source and self-host it; LAN multiplayer works for devices on the same Wi-Fi.

## Project setup

- **Title:** BoomBoom — Doodle Royale
- **Suggested URL slug:** `boomboom-doodle-royale`
- **Classification:** Games
- **Kind of project:** Downloadable — add the GitHub repository as an **External file**; do not select HTML because itch.io is not hosting a playable build
- **External file label:** `Source code / self-host on GitHub`
- **External URL:** https://github.com/daksh-mor/boomboom
- **Pricing:** `$0 / free` (No payments)
- **Release status:** In development
- **Short tagline:** Draw the battlefield. Survive the doodle.
- **One-sentence pitch:** A free, open-source LAN party FPS where sketches become solid, walkable geometry—battle through Doodle Royale, wield a pencil shooter, or escape a co-op dungeon.

## Full description

**Draw the level while you are playing it.**

BoomBoom — Doodle Royale is a free, MIT-licensed browser game for up to eight players. Open sketch mode, draw a shape, and cast it into the live multiplayer world as solid geometry that everyone can see and walk on. Build ramps and bridges, improvise cover, block routes, or draw an escape.

**Doodle Royale** turns that idea into five quick party rounds: climb above a rising ink tide, survive one-hit Draw Duels, and get off the bare floor before Floor Check strikes. Eliminated players spectate, the last-place player gets a little help, and the finale ends on a cinematic podium.

Want a different pace? Enter **Escape Room: The Doodle Dungeon** and cooperate on drawing puzzles—bridge a chasm, weigh down a high plate, and copy the magic key. Or choose one of three pencil-shooter modes for fast first-person combat where doodles become tactical cover and shortcuts.

Play from phones, tablets, and laptops on the same Wi-Fi. One computer runs the Node server; everyone joins in a modern browser with a four-character room code.

**There is currently no hosted public demo or public matchmaking.** Clone or download the project from GitHub and self-host it for your LAN. The project is an experimental prototype, shared as free and open-source software under the MIT License.

**Source code and setup:** https://github.com/daksh-mor/boomboom

## How to play and self-host

1. Install Node.js 20.19+ and npm, then clone or download the repository.
2. From the project folder, run:

   ```bash
   npm install
   npm run dev
   ```

3. On the host computer, open `http://localhost:5173`.
4. On other phones, tablets, or laptops connected to the same Wi-Fi, open the **Network** URL printed by Vite, such as `http://192.168.x.x:5173`.
5. Create a room, share its four-character code, choose a mode, and start.

### Controls

- **Desktop:** WASD to move, mouse to look, click to lock the pointer, left-click to fire, R to reload, Space to jump/double-jump, Q to draw, hold G to erase your ink, and hold Tab for the scoreboard.
- **Desktop sketching:** Hold left-click to draw; Enter or Q casts; Backspace undoes; Esc cancels.
- **Touch:** Left joystick to move, drag the right side to look, and use the on-screen FIRE, RELOAD, DRAW, ERASE, CAST, UNDO, and CANCEL controls. Landscape is recommended.

### Requirements

- Node.js 20.19+ and npm on the host computer
- A modern WebGL-capable browser
- Devices on the same Wi-Fi/LAN; the host firewall must allow local connections
- Keyboard and mouse or a touch screen; there is currently no gamepad support

## Discovery settings

- **Genre:** Action
- **Suggested tags (up to 10):** Multiplayer, Local multiplayer, First-Person, Shooter, Party Game, Co-op, Puzzle, 3D, Browser, Open Source
- **Platforms:** Windows, macOS, Linux (for hosting from source)
- **Mobile note:** Do not mark Android or iOS as native builds; phones and tablets join through their browsers.
- **Visibility:** Keep Restricted while assembling the page, then switch to Public after verification.

## Accessibility and content notes

- Desktop keyboard/mouse and mobile touch layouts are supported; mobile play is designed for landscape.
- The game uses fast first-person movement, camera motion, bright effects, damage flashes, and player colors. It has not had a formal accessibility audit.
- Controls are not currently remappable, gamepads are not supported, and color-vision accessibility may be limited.
- Contains stylized, non-gory pencil-shooter combat and player eliminations.

## Honest limitations

- LAN-first: multiplayer is intended for players on the same Wi-Fi.
- No hosted public demo, public server browser, or public matchmaking is currently available.
- Players must clone/download and self-host; this prototype is not hardened for open-Internet deployment.
- This is an experimental open-source prototype, not a finished commercial service.

## Screenshot upload order

Use this order and paste the captions below. **The publishing agent should omit any entry whose file is absent after release polish—never leave a broken image or invent a replacement.**

1. `docs/screenshots/doodle-royale-lobby.png`  
   *Create a room, share the four-character code, and choose from five modes.*
2. `docs/screenshots/pencil-shooter-combat.png`  
   *Pencil-shooter combat where live drawings become cover, ramps, and shortcuts.*
3. `docs/screenshots/doodle-dungeon-escape.png`  
   *Escape the Doodle Dungeon by drawing bridges, weights, and the final key.*
4. `docs/screenshots/doodle-royale-round-card.png`  
   *Doodle Royale serves five fast rounds with live standings and a deadpan Critic.*
5. `docs/screenshots/doodle-royale-rising-ink.png`  
   *Rising Ink: draw solid platforms and climb before the arena disappears.*
6. `docs/screenshots/doodle-royale-podium.png`  
   *The final podium crowns the Doodle Royale champion—and lets the room save the art.*

## Manual publishing checklist

- [ ] Confirm https://github.com/daksh-mor/boomboom is public and works while logged out.
- [ ] In itch.io, create a new project with the title and slug above.
- [ ] Set Classification to **Games**, Kind to **Downloadable**, price to **$0 / free**, and release status to **In development**.
- [ ] Under Uploads, choose **Add External File**, label it `Source code / self-host on GitHub`, and set its URL to https://github.com/daksh-mor/boomboom. Do not upload a placeholder build or enable browser play.
- [ ] Paste the tagline, full description, self-host steps, controls, requirements, accessibility notes, and limitations.
- [ ] Set the genre, tags, and desktop host platforms above; do not imply native mobile builds.
- [ ] Upload the available screenshots in order, add their captions, and omit any missing file.
- [ ] Save as Restricted and preview the complete page for formatting, image crops, and working links.
- [ ] Switch visibility to Public.
- [ ] Open the public itch page in a logged-out/incognito window and verify the page, screenshots, GitHub external link, and self-host instructions all work—and that the page does not imply a hosted demo or public matchmaking.
