# Arborism

Co-op tree-service game prototype. Runs in a browser, hosted on GitHub Pages,
peer-to-peer (one player hosts; their browser runs the physics).

**Status: physics prototype.** One tree, climbing with spurs and a lanyard, a
chainsaw whose cuts matter, and a rigging line with a friction device.
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

| | Gamepad | Keyboard / mouse |
|---|---|---|
| Move / climb (along and around the stem) | left stick | WASD |
| Look | right stick | mouse (click to capture) |
| Interact: spur in, grab rope tail, place rope | X | E |
| Clip / unclip lanyard | Y | F |
| Step off the tree | B | C |
| Jump | A | Space |
| Tool: hands / chainsaw / rigging rope | LB, RB | Q, R |
| Precision cut (hold), then throttle | LT, RT | right mouse, left mouse |
| While placing the bar: slide / rotate / tilt | left stick, right stick Y | WASD, Z / X |
| On the rope tail: ease grip / haul in / wraps | RT / LT / D-pad up-down | left / right mouse / arrows |
| Stress view | Back | Tab |
| Respawn (prototype) | Start | Enter |

### Things to try

- Spur up the trunk (X at the base). Clip in (Y) before using the saw. The
  lanyard will not pass a branch union: unclip, step past, clip again.
- Cut a limb from the top only, then try an undercut first. Watch the
  cross-section diagram: red wood is in tension, blue in compression.
- Fell the trunk: notch on the side it leans toward (a flat cut, then a
  sloping cut tilted to meet it), then a back cut that leaves a strip.
- Rigging (two players): climber hangs the block high (rope tool, X), ties
  the rope to a limb (X), cuts the limb. Ground player takes the tail at the
  red device on the trunk (X), sets wraps, and eases the trigger to lower it.

If a friend cannot connect, see "Known risks" in `docs/DESIGN.md`
(`?ice=` for a TURN relay, `?signal=` for another signaling server).

## Develop

See `CLAUDE.md`. No build step: `python3 -m http.server` in the repo root.

## License

Copyright (c) 2026 Nathan Spears. All rights reserved. See `LICENSE`.
Libraries in `vendor/` keep their own licenses.
