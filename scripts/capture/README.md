# Capture — regenerating the README screenshot and GIF

`screenshots/francois.png` and `screenshots/francois.gif` are captured from the
real app running against a **fake fleet**, not from a live session. A real
capture would leak whichever repo happened to be open, cost a live turn, and
never reproduce the same frame twice.

The fake fleet lives in `src/demo/` and is gated behind `VITE_FRANCOIS_DEMO=1`.
`DEMO` is a compile-time constant, so a normal `npm run build` drops the whole
module — nothing here ships.

## 1. Run the app in demo mode

```bash
VITE_FRANCOIS_DEMO=1 npm run dev:app
```

The demo backend intercepts `ipc()` and the event streams in `src/lib/api.ts`
(plus the shell's two call sites), so no `claude` process is spawned and no repo
is read. On boot it also seeds the localStorage keys that decide the opening
view — project scope, right-rail cards, theme — so every run starts identically.
A timeline then plays whole turns on a loop: streamed prose, tool calls, agent
steps, a rising context meter. The app is never a still frame.

## 2. Capture

`capture-window.ps1` grabs the window with `PrintWindow(PW_RENDERFULLCONTENT)`
— the only reliable path for a GPU-composited WebView2 window; a desktop grab
(`gdigrab`, `BitBlt`) yields black frames when the window is occluded and
captures anything on top of it. The result is cropped to DWM's extended frame
bounds, so there is no invisible Win11 resize border in the output.

A single still:

```powershell
./scripts/capture/capture-window.ps1 -Title 'orbit-api' -Out .capture/shot.png
```

The GIF sequence — 192 frames at 12 fps (16s), with the tab tour scripted.
Clicks are used rather than the app's single-letter shortcuts because the
composer textarea and the xterm terminal both swallow those:

```powershell
./scripts/capture/capture-window.ps1 -Title 'orbit-api' `
  -OutDir .capture/frames -Frames 192 -Fps 12 -Script @(
    '60|click|497,110',   # DIFF tab
    '68|click|373,237',   # retry.ts in the file list
    '108|click|566,110',  # SHELL tab
    '146|click|433,110',  # back to SESSION
    '152|key|^k',         # command palette
    '160|key|mod',        # type a query
    '182|key|{ESC}'
  )
```

Coordinates are in captured-frame (visible client) space — i.e. the same pixels
you measure on any output frame. Re-measure them if the window size changes.

## 3. Encode

```bash
cd .capture
ffmpeg -y -framerate 12 -i frames/f%04d.png -filter_complex \
  "fps=12,scale=1000:-1:flags=lanczos,split[a][b];\
   [a]palettegen=max_colors=128:stats_mode=diff[p];\
   [b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 francois.gif
```

~1.7 MB at 1000px wide, which is small enough to lead a README and still legible.
Then pick a still from `frames/` for `screenshots/francois.png` and copy both in.

`.capture/` is scratch space and is gitignored.
