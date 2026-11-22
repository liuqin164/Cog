# #418 UI evidence

The concept artifact is `~/dsh-dispatch/concept-418.html` (94,908 bytes). The implementation is the
single observatory shell at `/observatory/`; the chat view is injected by the `builtin:web-channel`
plugin through the host UI slot.

## Comparisons (`compare-*.png`)

Left is the concept render, right is the implementation with `?demo=1` and the chat slot mounted:

- `compare-chat-{dark,light}-desktop.png`, `compare-chat-{dark,light}-phone.png`: 1440×900 and
  390×844 CSS px.
- `compare-map-dark-desktop.png`, `compare-audit-dark-desktop.png`,
  `compare-soul-dark-desktop.png`: the other three shell views.

## Implementation (`shell-*.png`)

- `shell-chat-{dark,light}-{desktop,phone}.png`: chat view, Chinese companion name `小海`; the
  sidebar and message avatars show `小海`.
- `shell-chat-nova-avatar.png`: same page with the configured name `Nova`; the avatar shows `N`.
- `shell-map-dark-desktop.png`, `shell-audit-dark-desktop.png`,
  `shell-soul-dark-desktop.png`: the three observatory-owned views under the same shell.

## Concept references (`concept-*.png`)

Renders of `concept-418.html` at the same viewports/themes, used on the left of each comparison.
