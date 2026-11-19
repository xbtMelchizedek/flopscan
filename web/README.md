# Dashboard assets

| File | Source | License | Changes |
| --- | --- | --- | --- |
| `arc/foundation.css` | Arc free core, `arc-foundation` (uiarc.dev/r), fetched 18 Nov 2026 | MIT, Copyright (c) 2026 Elia Kuratli, see `arc/LICENSE` | none (sha256 `1e0a36d8…74efa`) |
| `arc/badge.css` | Arc free `badge` module, adapted to plain CSS | MIT, same notice | CSS-module wrappers removed, md size + dot + status tones only |
| `app.css` | ours | MIT (this repo) | layout only, Arc semantic roles only |

`scripts/build-site.mjs` also derives `theme-auto.css` from the dark block of `foundation.css`, so dark mode follows the
system setting without any script. Nothing from Arc Pro is used or reconstructed.
