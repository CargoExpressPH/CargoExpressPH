# PWA Install Screenshots

These images feed the `screenshots` array in `public/manifest.json`. Chrome uses them to
render the **rich install dialog** on desktop and the richer install sheet on Android.

They are **optional** for installability — the app installs fine without them. Until the six
files below exist, the manifest entries are inert (DevTools logs a download warning; install
still works).

## Required files

| Filename | Exact size | Form factor | Capture |
|---|---|---|---|
| `wide-1-dashboard.png`  | **1280×720** | wide   | Customer home / orders list, desktop width |
| `wide-2-booking.png`    | **1280×720** | wide   | Book Shipment page |
| `wide-3-tracking.png`   | **1280×720** | wide   | Tracking page with the status timeline |
| `narrow-1-home.png`     | **1080×1920** | narrow | Customer home, mobile viewport |
| `narrow-2-booking.png`  | **1080×1920** | narrow | Book Shipment, mobile viewport |
| `narrow-3-tracking.png` | **1080×1920** | narrow | Tracking timeline, mobile viewport |

Format: **PNG**. Dimensions must match the manifest exactly or Chrome rejects the entry.

## Chrome rules worth knowing

- At least one `form_factor: "wide"` screenshot is required for the desktop rich install dialog.
- Chrome shows a maximum of **8**; we declare 3 per form factor.
- Every wide screenshot should share the same aspect ratio (all ours are 16:9).
- Ratio must sit between 320:1 and 1:320, and no side under 320px or over 3840px.

## How to capture

1. `npm run build && npm run preview`
2. Open DevTools → **Ctrl/Cmd+Shift+M** (device toolbar).
3. **Wide:** set a custom viewport of `1280×720`, then Cmd/Ctrl+Shift+P → "Capture screenshot".
4. **Narrow:** set a custom viewport of `540×960` with DPR **2** → captures at 1080×1920.
   (Or use a real phone screenshot cropped to 1080×1920.)
5. Save into this folder using the exact filenames above.

Use real app screens with real seeded data. Do not mock up or retouch screens that the app
does not actually render — the install dialog is part of what a panel may inspect.

## Verifying

DevTools → **Application → Manifest** lists every screenshot and flags any that failed to
load or whose dimensions disagree with the manifest.
