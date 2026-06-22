# DICOM Viewer for Obsidian

A minimal, self-contained Obsidian plugin that views DICOM medical images as
scrollable 3D slices — similar to IMAIOS or eContour — directly inside your
vault. Click a `.dcm` file and the plugin loads the **whole series** from that
folder, sorts it into a volume, and lets you scroll through slices and adjust
window/level.

It is modeled on the lightweight
[ozempic-dicom-viewer](https://github.com/madacol/ozempic-dicom-viewer), but
rebuilt for Obsidian and reworked to be fully self-contained: it parses DICOM
with [`dicom-parser`](https://github.com/cornerstonejs/dicomParser) and renders
pixels to a canvas itself (modality rescale → window/level), so there are **no
runtime downloads, web workers, or WASM codecs** to bundle.

## Install (drop-in)

1. In your vault, create the folder
   `.obsidian/plugins/dicom-viewer/`
2. Copy these three files into it:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. In Obsidian: **Settings → Community plugins**, enable **DICOM Viewer**.
   (You may need to toggle "Restricted mode" off first.)

 

## Co-registration & image fusion

If a DICOM **Spatial Registration** object (modality `REG`) is present in the
folder alongside the image series, the viewer reads it automatically and lets you
**fuse** co-registered series on top of each other.

Each registration item maps one series' Frame of Reference into a common
registered space (the item with the identity matrix is the fixed reference — for
RT, typically the planning CT). The viewer uses these matrices to resample a
secondary series onto whatever slice you're viewing in the primary series.

**To fuse:** open the primary series, then in the toolbar's **Fuse** dropdown pick
a secondary series. Series that can be aligned to the primary are listed; a ⛓
marks ones aligned through a registration (versus simply sharing a Frame of
Reference). Choose a **colour map** and drag the **opacity** slider. The overlay
follows the primary as you scroll, zoom, and pan — each primary slice is
resampled through the registration with trilinear interpolation.

Notes:

- Put the `REG` file(s) in the same folder as the images (the **Load DICOM set**
  importer copies the whole folder, so exported registrations come along
  automatically).
- Rigid and affine matrix registrations are supported. **Deformable** spatial
  registration (`…66.3`) is detected but not yet applied (it needs a deformation
  grid rather than a single matrix).
- Building the overlay volume decodes every slice of the secondary series once
  (a progress message shows while it works); the volume is then cached.

## Multiple series in one folder

The left **Series** panel lists every series found in the folder (modality, slice
count, number, and description). Click a row to view that series. The active one
is highlighted. This is the right tool when a study folder mixes CT, localizers,
RTDOSE, etc.

### Slice ordering

Slices are ordered by **spatial position** by default: each slice is projected
onto a single shared volume normal, so series acquired in interleaved order
(common on MR — e.g. instance numbers 1, 3, 5, 2, 4) still scroll in true
anatomical order. If a particular series looks wrong, the toolbar **Sort**
dropdown switches between *position*, *instance number*, and *filename*.

## Importing & pointer notes (recommended workflow)

Run the command **"Load DICOM set"** from the command palette. It opens a native
folder picker — choose the folder that contains your DICOM slices. The plugin:

1. Prompts for a **name** for the set.
2. Copies the entire folder into `DICOM/files/[name]/` inside your vault. On a
   name collision it appends `-1`, `-2`, … and tells you the name it used.
3. Creates a pointer note `DICOM/[name].md` with this frontmatter:

   ```yaml
   ---
   type: dicom
   dicom_path: /DICOM/files/[name]
   ---
   ```

Generated notes contain a ` ```dicom ` code block, so they render the viewer in
**reading view, Live Preview, and embeds** alike. Any note with `type: dicom` +
`dicom_path` in its frontmatter also renders in reading view / embeds even
without the block. (If a hand-authored note doesn't render in Live Preview, add
an empty ` ```dicom ` code block to it.)

### Embedding inline

Transclude a pointer note to get an inline viewer in any note:

```
![[my-ct-set.md]]
```

The embed renders a compact viewer (sidebar hidden by default; toggle it with the
**☰** button). This lets a case write-up, teaching note, or daily note embed the
exact image set it refers to.

## Usage

- **Open a series:** put a DICOM series (one `.dcm` file per slice) in a folder
  in your vault and click any `.dcm` file. The plugin reads every DICOM in that
  folder, keeps the ones sharing the clicked file's `SeriesInstanceUID`, sorts
  them by slice position, and opens the volume.
- **Scroll slices:** mouse wheel, or arrow keys / PageUp / PageDown / Home /
  End.
- **Window / level:** left-drag — horizontal = window width, vertical = window
  center. (Hold **Shift** while dragging, or use the middle button, to pan.)
- **Zoom:** Ctrl/Cmd + mouse wheel (zooms around the cursor). Double-click
  resets zoom/pan. The **Fit** and **Reset W/L** buttons appear on hover.
- **Multi-frame files:** a single multi-frame DICOM (e.g. enhanced CT/MR, some
  ultrasound) scrolls frame-by-frame from the one file.
- **Extension-less series:** many exporters write slice files with no
  extension. Open any file in that folder, then run the command
  **"DICOM Viewer: View DICOM series in current folder"** — it sniffs files for
  the `DICM` magic bytes and opens the first image series.

## What this version supports

- **Uncompressed** transfer syntaxes: Implicit VR LE, Explicit VR LE/BE.
- **JPEG 2000** (`.90` lossless / `.91` lossy) via an OpenJPEG WASM decoder
  inlined into the bundle — **no runtime downloads**. This is what Siemens and
  many scanners use.
- **RLE Lossless** (`.5`) via a pure-JS decoder.
- 8/16-bit grayscale (`MONOCHROME1`/`MONOCHROME2`) with Rescale Slope/Intercept
  (correct Hounsfield Units for CT) and the DICOM linear VOI LUT.
- RGB and `YBR_FULL` color (interleaved or planar).
- Geometric slice sorting via `ImageOrientationPatient` / `ImagePositionPatient`
  (falls back to `SliceLocation`, then `InstanceNumber`, then filename).
- **Extension-less series** (e.g. `IM1`, `IM2`, …): right-click the folder →
  **Open as DICOM series**, or run the **View DICOM series in current folder**
  command. This reads the folder straight from disk via the vault adapter, so it
  works even though Obsidian hides files without a recognized extension.

## Mouse & keyboard

- **Scroll** = change slice. **Ctrl/Cmd + scroll** = zoom (about the cursor).
- **Left-drag** = window/level the *reference* series.
- **Alt-drag** (or **Cmd-drag**) = window/level the *fused-in* series.
- **Ctrl-drag** (or **Shift-drag**, or **middle-drag**) = pan.
- **Ctrl/Cmd + A** = invert the fusion opacity (0↔100, 80↔20, …), matching
  Eclipse. Double-click = reset zoom/pan.
- Arrow keys / PageUp-Down / Home / End also navigate slices.

A toolbar (visible on hover) offers window/level **presets** — Soft tissue, Lung,
Bone, Brain, Liver, Mediastinum, Angio/PE, plus Default and Full range — and
**exact numeric W / L inputs**. CT series show an `HU` label.

## Renaming series (persistent)

**Double-click a series name** in the left panel to rename it. The new label is
saved in the pointer note's frontmatter under `dicom_series_labels` (keyed by
SeriesInstanceUID) — the `.dcm` files are never modified. Labels are only saved
when the viewer is opened through a DICOM pointer note (see below).

## Not yet supported (clearly reported, not silently broken)

- Other compressed syntaxes: **baseline/extended JPEG** (`.50`/`.51`),
  **JPEG Lossless** (`.57`/`.70`), **JPEG-LS** (`.80`/`.81`). The viewer names
  the exact transfer syntax instead of rendering garbage; each is a drop-in
  addition following the same codec pattern as JPEG 2000.
- RT structure-set overlays (see roadmap).

## Roadmap toward RayStation structure sets

This was built as a foundation for viewing RayStation RTSTRUCT exports. The
groundwork is already here:

- Series are grouped by `SeriesInstanceUID`, and slice geometry
  (orientation + position + pixel spacing) is parsed — exactly what's needed to
  map RTSTRUCT contour coordinates (patient mm) onto the right CT slices
  (pixel space).
- Next steps: parse the `RTSTRUCT` `ROIContourSequence`, match its
  `ReferencedSeriesInstanceUID` to the loaded CT series, convert each contour's
  patient coordinates to pixel coordinates per slice, and draw them as colored
  polygons over the canvas — with an ROI list to toggle visibility.

## Performance notes

- The plugin reads and parses every candidate file in the folder to assemble the
  series, then **releases all but the chosen series** to bound memory. Decoded
  slices are cached with a small LRU (default 48), so very large series stay
  responsive without holding every slice in RAM.

## Build from source

```bash
npm install
npm run build      # type-checks, then bundles to main.js
# or: npm run dev  # watch mode
```

Source layout:

- `src/dicom.ts` — parsing, pixel decoding, window/level, series assembly
  (no Obsidian dependencies; unit-tested by `test/smoke.ts`).
- `main.ts` — the Obsidian `FileView`, canvas rendering, interaction, and
  plugin registration.

Run the logic test (builds a synthetic CT in memory and checks the math):

```bash
npx esbuild test/smoke.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke.cjs
node -e "global.ImageData=class{constructor(d,w,h){this.data=d;this.width=w;this.height=h;}}; require('/tmp/smoke.cjs');"
```

## License

MIT. `dicom-parser` is MIT-licensed (Cornerstone.js).
