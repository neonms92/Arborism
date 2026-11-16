# Arborism

Co-op tree-service game prototype. Runs in a browser, hosted on GitHub Pages,
peer-to-peer (one player hosts; their browser runs the physics).

**Status: physics prototype.** One tree made of individually loaded wood
fibres, climbing with spurs and a lanyard, a free-swinging chainsaw that
severs fibres, and a rigging line with a friction device.
See `docs/STATUS.md`.

## Play

1. Open the page. **Host** shows a 5-letter room code in the top-left corner.
2. Friends open the same page, type the code, **Join**.
3. **Solo** runs the same game with no network.

### Steam Deck

The browser only sees a gamepad when it is launched *through Steam*:
in Desktop Mode right-click your browser → "Add to Steam", then start it from
Game Mode (the default "Gamepad" layout works). In plain Desktop Mode the Deck
pretends to be a mouse and keyboard. Type the room code with the on-screen
keyboard (Steam + X), or share a link ending in `?join=CODE`.

### Controls

The game names controls on screen for whichever device you touched last.
Vertical look is inverted (forward looks down).

| | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / climb (along and around the stem) | WASD | left stick |
| Look | mouse (click to capture) | right stick |
| Use: spur in, move the lanyard, grab rope tail, place rope | E | X |
| Let go of the tree (you fall) | C | B |
| Jump | Space | A |
| Tool: hands / chainsaw / rigging rope | Q, R | LB, RB |
| Raise the saw (hold) — looking now swings the bar | right mouse | LT |
| Run the chain | left mouse | RT |
| On the rope tail: ease grip / haul in / wraps | left / right mouse / arrows | RT / LT / D-pad up-down |
| Fibre view / bark | Tab | Back |
| Respawn (prototype) | Enter | Start |

### Things to try

- The tree starts in the debug view: every wood fibre is drawn. Yellow is
  unloaded, red is compression, blue is tension, green is bending.
- Spur up the trunk (use, at the base, with hands out). You are on a lanyard
  the whole time. It will not slide past a branch union: look at the stem
  beyond it and use again to throw the lanyard there. Letting go drops you.
- Chainsaw: look where you want the saw, hold raise, then sweep the bar into
  the wood with the look controls while running the chain. It rests on the
  wood and works through it fibre by fibre. You can walk or climb with it.
  It will cut ropes, and your own lanyard.
- Cut a limb from the top only, then try an undercut first.
- Fell the trunk: a notch on the side it leans toward (a level cut and a
  sloping cut that meets it), then a back cut that leaves a strip of fibres.
- Rigging (two players): climber hangs the block high (rope tool, use), ties
  the rope to a limb (use), cuts the limb. Ground player takes the tail at
  the red device on the trunk (use), sets wraps, and eases off to lower it.

If a friend cannot connect, see "Known risks" in `docs/DESIGN.md`
(`?ice=` for a TURN relay, `?signal=` for another signaling server).

## Develop

See `CLAUDE.md`. No build step: `python3 -m http.server` in the repo root.
