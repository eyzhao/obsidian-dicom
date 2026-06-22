/*
 * main.ts — Obsidian plugin entry.
 *
 * Registers a FileView for DICOM files. Opening a .dcm file loads every DICOM
 * slice in the same folder that shares its SeriesInstanceUID, sorts them into a
 * 3D volume, and lets you scroll through slices with the mouse wheel while
 * adjusting window/level by dragging — similar to IMAIOS / eContour.
 */

import {
	App,
	Component,
	FileView,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Modal,
	normalizePath,
	Notice,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import {
	buildSeries,
	classifyTransferSyntax,
	CompressedDicomError,
	decodeFrame,
	DecodedSlice,
	ensureCodecReady,
	looksLikeDicom,
	modalityOf,
	ParsedFile,
	Series,
	seriesUidOf,
	sopClassOf,
	SortMode,
	sortSeries,
	transferSyntaxOf,
	tryParse,
	windowToImageData,
} from "./src/dicom";
import {
	isRegistrationSOP,
	Mat4,
	parseRegistration,
	RegistrationRegistry,
} from "./src/registration";
import {
	buildVolume,
	PlaneGeometry,
	resamplePlane,
	ResampledPlane,
	Volume,
} from "./src/volume";

export const VIEW_TYPE_DICOM = "dicom-view";
const DICOM_EXTENSIONS = ["dcm", "dicom", "ima", "img"];
const DECODE_CACHE_SIZE = 48;
const READ_CONCURRENCY = 8;
const DICOM_ROOT = "DICOM";
const DICOM_FILES_DIR = "DICOM/files";

export default class DicomViewerPlugin extends Plugin {
	async onload() {
		this.registerView(
			VIEW_TYPE_DICOM,
			(leaf) => new DicomView(leaf, this)
		);

		// Files with these extensions open in the DICOM view on click.
		try {
			this.registerExtensions(DICOM_EXTENSIONS, VIEW_TYPE_DICOM);
		} catch (e) {
			console.warn(
				"DICOM Viewer: some extensions were already registered by " +
					"another plugin and were skipped.",
				e
			);
		}

		// Import an external DICOM folder into the vault as a pointer note.
		this.addCommand({
			id: "load-dicom-set",
			name: "Load DICOM set",
			callback: () => this.importDicomSet(),
		});

		// Open a folder already in the vault straight from disk.
		this.addCommand({
			id: "open-folder-as-series",
			name: "View DICOM series in current folder",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				const folderPath = active?.parent?.path;
				if (!folderPath) {
					new Notice("Open any file inside the DICOM folder first.");
					return;
				}
				this.openFolderAsSeries(folderPath);
			},
		});

		// Right-click a folder in the file explorer → "Open as DICOM series".
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Open as DICOM series")
							.setIcon("scan")
							.onClick(() => this.openFolderAsSeries(file.path))
					);
				}
			})
		);

		// Render DICOM pointer notes as the viewer. Two mechanisms:
		//  (1) a ```dicom code block — renders reliably in reading view, Live
		//      Preview, and ![[embeds]]. Generated pointer notes include it.
		//  (2) a frontmatter fallback (type: dicom) for hand-authored notes
		//      with no code block — reading view / embeds.
		this.registerMarkdownCodeBlockProcessor("dicom", (source, el, ctx) =>
			this.renderDicomCodeBlock(source, el, ctx)
		);
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.renderDicomPointer(el, ctx)
		);

		this.addCommand({
			id: "reset-window-level",
			name: "Reset window/level and zoom",
			checkCallback: (checking) => {
				const view =
					this.app.workspace.getActiveViewOfType(DicomView);
				if (!view) return false;
				if (!checking) view.resetAll();
				return true;
			},
		});
	}

	onunload() {
		// Obsidian detaches leaves of this view type automatically.
	}

	/** Open the DICOM view on a leaf and load a folder from disk. */
	async openFolderAsSeries(folderPath: string) {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_DICOM, active: true });
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof DicomView) {
			await view.loadFolder(folderPath);
		}
	}

	// ---- pointer-note rendering ----------------------------------------------
	private previewRootOf(el: HTMLElement): HTMLElement | null {
		return el.closest(
			".markdown-embed-content, .markdown-preview-view, .markdown-rendered"
		) as HTMLElement | null;
	}

	private dicomPathFromFrontmatter(
		ctx: MarkdownPostProcessorContext
	): string | null {
		const fm =
			(ctx as unknown as { frontmatter?: Record<string, unknown> })
				.frontmatter ??
			this.app.metadataCache.getCache(ctx.sourcePath)?.frontmatter;
		if (!fm || fm["type"] !== "dicom" || !fm["dicom_path"]) return null;
		return normalizePath(stripLeadingSlash(String(fm["dicom_path"])));
	}

	/** ```dicom code block → viewer. Path comes from frontmatter or the block. */
	private renderDicomCodeBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		let path = this.dicomPathFromFrontmatter(ctx);
		if (!path) {
			// Allow `dicom_path: ...` or a bare path inside the block body.
			const line = source
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 0);
			if (line) {
				const m = line.match(/^(?:dicom_path|path)\s*:\s*(.+)$/);
				path = normalizePath(stripLeadingSlash(m ? m[1] : line));
			}
		}
		if (!path) {
			el.createDiv({
				cls: "dicom-message",
				text: "DICOM viewer: no dicom_path in frontmatter or block.",
			});
			return;
		}
		const root = this.previewRootOf(el);
		if (root) root.dataset.dicomMounted = "1";
		const isEmbed = !!el.closest(".markdown-embed");
		const host = el.createDiv({
			cls:
				"dicom-render-host " +
				(isEmbed ? "dicom-embed-host" : "dicom-fullpage-host"),
		});
		ctx.addChild(new DicomRenderChild(this.app, host, path, ctx.sourcePath));
	}

	private renderDicomPointer(
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const path = this.dicomPathFromFrontmatter(ctx);
		if (!path) return;

		// Mount one viewer per rendered document/embed; hide the markdown body.
		const root = this.previewRootOf(el) || el;
		if (root.dataset.dicomMounted) {
			el.style.display = "none";
			return;
		}
		// If a ```dicom block is present, let the code-block processor handle it.
		if (root.querySelector(".block-language-dicom")) {
			el.style.display = "none";
			return;
		}
		root.dataset.dicomMounted = "1";

		const isEmbed = !!el.closest(".markdown-embed");
		const host = createDiv({
			cls:
				"dicom-render-host " +
				(isEmbed ? "dicom-embed-host" : "dicom-fullpage-host"),
		});
		el.parentElement?.insertBefore(host, el);
		el.style.display = "none";
		ctx.addChild(
			new DicomRenderChild(this.app, host, path, ctx.sourcePath)
		);
	}

	// ---- import ---------------------------------------------------------------
	private async importDicomSet() {
		const files = await pickDirectory();
		if (!files || files.length === 0) return;

		const defaultName =
			(files[0].webkitRelativePath || files[0].name).split("/")[0] ||
			"dicom-set";

		const rawName = await this.promptName(defaultName);
		if (!rawName) return;

		const requested = sanitizeName(rawName);
		const finalName = await this.resolveCollision(requested);
		if (finalName !== requested) {
			new Notice(
				`"${requested}" already exists — imported as "${finalName}".`
			);
		}

		const destBase = `${DICOM_FILES_DIR}/${finalName}`;
		const adapter = this.app.vault.adapter;
		await this.ensureFolder(destBase);

		const fileArray = Array.from(files);
		const progress = new Notice(`Importing 0/${fileArray.length} files…`, 0);
		let count = 0;
		try {
			for (const f of fileArray) {
				// Strip the selected folder's own name from the relative path.
				const rel =
					(f.webkitRelativePath || f.name)
						.split("/")
						.slice(1)
						.join("/") || f.name;
				const dest = `${destBase}/${rel}`;
				const slash = dest.lastIndexOf("/");
				if (slash > 0) await this.ensureFolder(dest.slice(0, slash));
				const buf = await f.arrayBuffer();
				await adapter.writeBinary(dest, buf);
				count++;
				if (count % 10 === 0 || count === fileArray.length) {
					progress.setMessage(
						`Importing ${count}/${fileArray.length} files…`
					);
				}
			}
		} finally {
			progress.hide();
		}

		// Create the pointer note. The ```dicom block renders in every mode.
		const mdPath = `${DICOM_ROOT}/${finalName}.md`;
		const content =
			`---\n` +
			`type: dicom\n` +
			`dicom_path: /${destBase}\n` +
			`---\n\n` +
			`# ${rawName}\n\n` +
			"```dicom\n```\n";
		const mdFile = await this.app.vault.create(mdPath, content);

		new Notice(`Imported ${count} files → ${destBase}`);
		await this.app.workspace.getLeaf(true).openFile(mdFile);
	}

	private promptName(defaultValue: string): Promise<string | null> {
		return new Promise((resolve) => {
			new NameModal(this.app, defaultValue, resolve).open();
		});
	}

	/** Append -1, -2, … until neither the files folder nor the note exist. */
	private async resolveCollision(name: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const taken = async (n: string) =>
			(await adapter.exists(`${DICOM_FILES_DIR}/${n}`)) ||
			(await adapter.exists(`${DICOM_ROOT}/${n}.md`));
		if (!(await taken(name))) return name;
		for (let i = 1; ; i++) {
			const candidate = `${name}-${i}`;
			if (!(await taken(candidate))) return candidate;
		}
	}

	/** Recursively create a vault folder (indexed), tolerant of existing ones. */
	private async ensureFolder(path: string) {
		if (this.app.vault.getAbstractFileByPath(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch {
			// Already exists on disk (or a race) — fall back to adapter mkdir
			// so binary writes still land in the right place.
			const adapter = this.app.vault.adapter;
			const parts = path.split("/");
			let cur = "";
			for (const p of parts) {
				cur = cur ? `${cur}/${p}` : p;
				if (!(await adapter.exists(cur))) {
					try {
						await adapter.mkdir(cur);
					} catch {
						/* ignore */
					}
				}
			}
		}
	}
}

function stripLeadingSlash(p: string): string {
	return p.replace(/^\/+/, "");
}

function sanitizeName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	return cleaned || "dicom-set";
}

/** Native directory picker via a hidden <input webkitdirectory>. */
function pickDirectory(): Promise<FileList | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		(input as unknown as { webkitdirectory: boolean }).webkitdirectory =
			true;
		input.style.display = "none";
		let settled = false;
		const done = (v: FileList | null) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(v);
		};
		input.addEventListener("change", () => done(input.files));
		input.addEventListener("cancel", () => done(null));
		document.body.appendChild(input);
		input.click();
	});
}

function isDicomExtension(ext: string): boolean {
	return DICOM_EXTENSIONS.includes(ext.toLowerCase());
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
type ColorFn = (t: number) => [number, number, number];
const COLORMAPS: Record<string, ColorFn> = {
	hot: (t) => [
		Math.round(clamp01((8 / 3) * t) * 255),
		Math.round(clamp01((8 / 3) * t - 1) * 255),
		Math.round(clamp01(4 * t - 3) * 255),
	],
	cyan: (t) => [0, Math.round(t * 255), Math.round(t * 255)],
	green: (t) => [0, Math.round(t * 255), 0],
	magenta: (t) => [Math.round(t * 255), 0, Math.round(t * 255)],
	blue: (t) => [Math.round(t * 110), Math.round(t * 160), Math.round(t * 255)],
	gray: (t) => {
		const v = Math.round(t * 255);
		return [v, v, v];
	},
};

// Standard CT window presets, width/level in Hounsfield units.
const CT_PRESETS: { key: string; name: string; w: number; l: number }[] = [
	{ key: "soft", name: "Soft tissue", w: 400, l: 40 },
	{ key: "abdomen", name: "Abdomen", w: 350, l: 50 },
	{ key: "lung", name: "Lung", w: 1500, l: -600 },
	{ key: "bone", name: "Bone", w: 2000, l: 300 },
	{ key: "brain", name: "Brain", w: 80, l: 40 },
	{ key: "liver", name: "Liver", w: 150, l: 30 },
	{ key: "mediastinum", name: "Mediastinum", w: 350, l: 40 },
	{ key: "angio", name: "Angio / PE", w: 700, l: 100 },
];

// =============================================================================
// The view
// =============================================================================
type DragMode = "none" | "windowing" | "windowing-overlay" | "pan";

export class DicomRenderer extends Component {
	private app: App;
	private host: HTMLElement;
	private compact: boolean;
	private sidebarVisible: boolean;
	private notePath: string | null;
	private seriesLabels = new Map<string, string>();

	private root!: HTMLDivElement;
	private sidebar!: HTMLDivElement;
	private stage!: HTMLDivElement;
	private seriesListEl!: HTMLDivElement;
	private sortSelect!: HTMLSelectElement;
	private sortMode: SortMode = "position";
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private offscreen!: HTMLCanvasElement;
	private offctx!: CanvasRenderingContext2D;
	private overlayTL!: HTMLDivElement;
	private overlayTR!: HTMLDivElement;
	private overlayBL!: HTMLDivElement;
	private overlayBR!: HTMLDivElement;
	private scrollThumb!: HTMLDivElement;
	private messageEl!: HTMLDivElement;
	private presetSelect!: HTMLSelectElement;
	private wInput!: HTMLInputElement;
	private lInput!: HTMLInputElement;
	private isCT = false;

	private series: Series | null = null;
	private allSeries: Series[] = [];
	private sliceIndex = 0;
	private decodeCache = new Map<number, DecodedSlice>();
	private current: DecodedSlice | null = null;

	private windowCenter = 0;
	private windowWidth = 1;
	private zoom = 1;
	private panX = 0;
	private panY = 0;

	private dragMode: DragMode = "none";
	private lastX = 0;
	private lastY = 0;

	private resizeObserver: ResizeObserver | null = null;
	private loadToken = 0;

	// ---- fusion / co-registration ----
	private registry = new RegistrationRegistry();
	private fusionSelect!: HTMLSelectElement;
	private opacityInput!: HTMLInputElement;
	private colormapSelect!: HTMLSelectElement;
	private overlayCanvas!: HTMLCanvasElement;
	private overlayCtx!: CanvasRenderingContext2D;
	private overlaySeriesUid: string | null = null;
	private overlayVolume: Volume | null = null;
	private overlayMatrix: Mat4 | null = null; // primary FoR -> overlay FoR
	private overlayCache = new Map<number, ResampledPlane>();
	private volumeCache = new Map<string, Volume>();
	private overlayOpacity = 1.0;
	private overlayColormap = "gray";
	private overlayCenter = 0;
	private overlayWidth = 1;

	constructor(
		app: App,
		host: HTMLElement,
		opts: { compact?: boolean; notePath?: string } = {}
	) {
		super();
		this.app = app;
		this.host = host;
		this.compact = !!opts.compact;
		this.sidebarVisible = !opts.compact; // hidden by default in embeds
		this.notePath = opts.notePath ?? null;
	}

	onload() {
		this.buildDom();
	}

	onunload() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.releaseSeries();
		this.host.empty();
	}

	private buildDom() {
		const container = this.host;
		container.empty();
		container.style.padding = "0";

		this.root = container.createDiv({ cls: "dicom-view-container" });
		if (this.compact) this.root.addClass("dicom-compact");

		// Left: series list. Right: the image stage.
		this.sidebar = this.root.createDiv({ cls: "dicom-sidebar" });
		this.sidebar.createDiv({ cls: "dicom-sidebar-title", text: "Series" });
		this.seriesListEl = this.sidebar.createDiv({
			cls: "dicom-series-list",
		});
		if (!this.sidebarVisible) this.sidebar.hide();

		this.stage = this.root.createDiv({ cls: "dicom-stage" });
		this.stage.tabIndex = 0;

		this.canvas = this.stage.createEl("canvas", { cls: "dicom-canvas" });
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("2D canvas context unavailable");
		this.ctx = ctx;

		this.offscreen = document.createElement("canvas");
		this.offctx = this.offscreen.getContext("2d")!;
		this.overlayCanvas = document.createElement("canvas");
		this.overlayCtx = this.overlayCanvas.getContext("2d")!;

		// Toolbar
		const bar = this.stage.createDiv({ cls: "dicom-toolbar" });
		this.addToolButton(bar, "☰", () => {
			this.sidebarVisible = !this.sidebarVisible;
			if (this.sidebarVisible) this.sidebar.show();
			else this.sidebar.hide();
			this.draw();
		});
		this.addToolButton(bar, "Fit", () => {
			this.zoom = 1;
			this.panX = 0;
			this.panY = 0;
			this.draw();
		});
		this.addToolButton(bar, "Reset W/L", () => {
			if (this.current) {
				this.windowCenter = this.current.defaultCenter;
				this.windowWidth = this.current.defaultWidth;
				this.render();
			}
		});

		// Window/level: presets + exact numeric entry (dynamic HU control).
		const sep = bar.createSpan({ cls: "dicom-tool-sep" });
		sep.setText("│");

		// Slice ordering control.
		this.sortSelect = bar.createEl("select", { cls: "dicom-preset" });
		(
			[
				["position", "Sort: position"],
				["instance", "Sort: instance #"],
				["filename", "Sort: filename"],
			] as [SortMode, string][]
		).forEach(([v, label]) =>
			this.sortSelect.createEl("option", { value: v, text: label })
		);
		this.registerDomEvent(this.sortSelect, "change", () => {
			this.sortMode = this.sortSelect.value as SortMode;
			this.applySort();
		});

		const sep2 = bar.createSpan({ cls: "dicom-tool-sep" });
		sep2.setText("│");

		this.presetSelect = bar.createEl("select", { cls: "dicom-preset" });
		this.registerDomEvent(this.presetSelect, "change", () => {
			this.applyPreset(this.presetSelect.value);
		});

		const wl = bar.createSpan({ cls: "dicom-wl" });
		wl.createSpan({ text: "W" });
		this.wInput = wl.createEl("input", { type: "number" });
		wl.createSpan({ text: "L" });
		this.lInput = wl.createEl("input", { type: "number" });
		const applyFromInputs = () => {
			const w = parseFloat(this.wInput.value);
			const l = parseFloat(this.lInput.value);
			if (!Number.isNaN(w)) this.windowWidth = Math.max(1, w);
			if (!Number.isNaN(l)) this.windowCenter = l;
			this.presetSelect.value = "custom";
			this.render();
		};
		this.registerDomEvent(this.wInput, "change", applyFromInputs);
		this.registerDomEvent(this.lInput, "change", applyFromInputs);

		// Fusion / co-registration controls.
		const sep3 = bar.createSpan({ cls: "dicom-tool-sep" });
		sep3.setText("│");
		const fl = bar.createSpan({ cls: "dicom-wl" });
		fl.createSpan({ text: "Fuse" });
		this.fusionSelect = fl.createEl("select", { cls: "dicom-preset" });
		this.registerDomEvent(this.fusionSelect, "change", () => {
			const v = this.fusionSelect.value;
			this.setOverlay(v === "none" ? null : v);
		});
		this.colormapSelect = fl.createEl("select", { cls: "dicom-preset" });
		(["gray", "hot", "cyan", "green", "magenta", "blue"] as const).forEach(
			(c) =>
				this.colormapSelect.createEl("option", { value: c, text: c })
		);
		this.colormapSelect.value = this.overlayColormap;
		this.registerDomEvent(this.colormapSelect, "change", () => {
			this.overlayColormap = this.colormapSelect.value;
			this.draw();
		});
		this.opacityInput = fl.createEl("input", { type: "range" });
		this.opacityInput.min = "0";
		this.opacityInput.max = "100";
		this.opacityInput.value = String(this.overlayOpacity * 100);
		this.opacityInput.style.width = "70px";
		this.registerDomEvent(this.opacityInput, "input", () => {
			this.overlayOpacity = parseInt(this.opacityInput.value, 10) / 100;
			this.draw();
		});

		// Don't let clicks/drags on the controls scroll slices or window-level.
		this.registerDomEvent(bar, "wheel", (e) => e.stopPropagation());
		this.registerDomEvent(bar, "mousedown", (e) => e.stopPropagation());

		// Overlays
		this.overlayTL = this.stage.createDiv({
			cls: "dicom-overlay dicom-overlay-tl",
		});
		this.overlayTR = this.stage.createDiv({
			cls: "dicom-overlay dicom-overlay-tr",
		});
		this.overlayBL = this.stage.createDiv({
			cls: "dicom-overlay dicom-overlay-bl",
		});
		this.overlayBR = this.stage.createDiv({
			cls: "dicom-overlay dicom-overlay-br",
		});

		const sb = this.stage.createDiv({ cls: "dicom-scrollbar" });
		this.scrollThumb = sb.createDiv({ cls: "dicom-scrollbar-thumb" });

		this.messageEl = this.stage.createDiv({ cls: "dicom-message" });
		this.messageEl.hide();

		this.registerInteractions();

		this.resizeObserver = new ResizeObserver(() => this.draw());
		this.resizeObserver.observe(this.stage);
	}

	// ---- loading --------------------------------------------------------------
	/**
	 * Load every DICOM in a folder straight from disk via the vault adapter.
	 * This does NOT depend on Obsidian's file index, so it picks up
	 * extension-less slice files (IM1, IM2, …) that Obsidian hides.
	 * `preferSeriesUid` selects which series to show first (e.g. the clicked file).
	 */
	async loadFromFolder(folderPath: string, preferSeriesUid?: string) {
		const token = ++this.loadToken;
		this.releaseSeries();
		this.loadSeriesLabels();
		this.showMessage("Loading series…", "");

		let listing: { files: string[] };
		try {
			listing = await this.app.vault.adapter.list(folderPath);
		} catch (e) {
			this.showMessage("Could not read folder", String(e));
			return;
		}

		const parsed: ParsedFile[] = [];
		await runPool(listing.files, READ_CONCURRENCY, async (path) => {
			if (token !== this.loadToken) return;
			try {
				const buf = await this.app.vault.adapter.readBinary(path);
				const bytes = new Uint8Array(buf);
				const ext = path.includes(".")
					? path.slice(path.lastIndexOf(".") + 1)
					: "";
				if (!isDicomExtension(ext) && !looksLikeDicom(bytes)) return;
				const pf = tryParse(path, bytes);
				if (pf) parsed.push(pf);
			} catch (e) {
				console.warn("DICOM Viewer: failed to read", path, e);
			}
		});

		// Collect spatial registration objects so series can be fused.
		this.registry = new RegistrationRegistry();
		for (const pf of parsed) {
			const sop = sopClassOf(pf.dataSet);
			if (isRegistrationSOP(sop)) {
				try {
					this.registry.add(parseRegistration(pf.dataSet));
				} catch (e) {
					console.warn("DICOM Viewer: bad REG object", e);
				}
			}
		}

		await this.displaySeries(parsed, preferSeriesUid, token);
	}

	/** Build the series list, then select the most relevant series. */
	private async displaySeries(
		parsed: ParsedFile[],
		openedSeriesUid: string | undefined,
		token: number
	) {
		if (token !== this.loadToken) return;

		const allSeries = buildSeries(parsed);
		if (allSeries.length === 0) {
			this.allSeries = [];
			this.populateSeriesList();
			this.showMessage(
				"No viewable image data",
				"No DICOM image pixels were found in this folder."
			);
			return;
		}

		this.allSeries = allSeries;
		// Honour the active sort mode for every series.
		for (const s of allSeries) sortSeries(s, this.sortMode);
		this.populateSeriesList();

		let initial = 0;
		if (openedSeriesUid) {
			const i = allSeries.findIndex(
				(s) => s.seriesUID === openedSeriesUid
			);
			if (i >= 0) initial = i;
		}
		await this.selectSeries(initial, token);
	}

	/** Load one series into the viewer (codec prep, decode, render, highlight). */
	private async selectSeries(index: number, token = this.loadToken) {
		const chosen = this.allSeries[index];
		if (!chosen) return;

		this.series = chosen;
		this.sliceIndex = Math.floor(chosen.slices.length / 2);
		this.decodeCache.clear();
		this.current = null;
		this.highlightSeries(index);

		const ds0 = chosen.slices[0].dataSet;
		const ts = transferSyntaxOf(ds0);
		if (classifyTransferSyntax(ts) === "jpeg2000") {
			this.showMessage("Preparing JPEG 2000 decoder…", "");
			try {
				await ensureCodecReady(ts);
			} catch (e) {
				this.showMessage("Failed to load image decoder", String(e));
				return;
			}
			if (token !== this.loadToken) return;
		}

		try {
			this.current = this.getDecoded(this.sliceIndex);
		} catch (e) {
			if (e instanceof CompressedDicomError) {
				this.showMessage(
					"Unsupported compression",
					`Transfer syntax ${e.transferSyntax ?? "unknown"} isn't ` +
						"decoded yet. This build handles uncompressed, " +
						"JPEG 2000 (.90/.91), and RLE Lossless (.5). " +
						"JPEG-LS and baseline JPEG can be added next."
				);
				return;
			}
			this.showMessage("Could not decode image", String(e));
			return;
		}

		this.windowCenter = this.current.defaultCenter;
		this.windowWidth = this.current.defaultWidth;
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		this.isCT = (modalityOf(ds0) ?? "").toUpperCase().includes("CT");
		this.hideMessage();
		this.populatePresets();
		this.resetOverlay();
		this.populateFusionOptions();
		this.render();
	}

	// ---- fusion ---------------------------------------------------------------
	/** List series that can be overlaid on the current primary. */
	private populateFusionOptions() {
		const sel = this.fusionSelect;
		sel.empty();
		sel.createEl("option", { value: "none", text: "none" });
		if (!this.series) return;
		const primaryFoR = this.series.frameOfReferenceUID;
		for (const s of this.allSeries) {
			if (s === this.series) continue;
			const sameFoR =
				!!primaryFoR && s.frameOfReferenceUID === primaryFoR;
			const registered = !!this.registry.transform(
				primaryFoR,
				s.frameOfReferenceUID
			);
			if (!sameFoR && !registered) continue; // can't align — skip
			const desc =
				this.seriesLabels.get(s.seriesUID) ??
				s.description ??
				`series ${s.seriesNumber}`;
			const label =
				(s.modality ? s.modality + " " : "") +
				desc +
				(registered && !sameFoR ? " ⛓" : "");
			sel.createEl("option", { value: s.seriesUID, text: label });
		}
		sel.value = "none";
	}

	private resetOverlay() {
		this.overlaySeriesUid = null;
		this.overlayVolume = null;
		this.overlayMatrix = null;
		this.overlayCache.clear();
		if (this.fusionSelect) this.fusionSelect.value = "none";
	}

	/** Flip fusion opacity: 0↔100, 80↔20, etc. (Eclipse Ctrl+A behaviour). */
	private invertFusionOpacity() {
		this.overlayOpacity = 1 - this.overlayOpacity;
		if (this.opacityInput) {
			this.opacityInput.value = String(Math.round(this.overlayOpacity * 100));
		}
		this.draw();
	}

	private async setOverlay(seriesUid: string | null) {
		this.overlayCache.clear();
		if (!seriesUid || !this.series) {
			this.overlaySeriesUid = null;
			this.overlayVolume = null;
			this.overlayMatrix = null;
			this.draw();
			return;
		}
		const overlay = this.allSeries.find((s) => s.seriesUID === seriesUid);
		if (!overlay) return;

		const primaryFoR = this.series.frameOfReferenceUID;
		const overlayFoR = overlay.frameOfReferenceUID;
		const matrix =
			this.registry.transform(primaryFoR, overlayFoR) ??
			(primaryFoR && primaryFoR === overlayFoR
				? // identical frame: no transform needed
				  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
				: null);
		if (!matrix) {
			new Notice(
				"No spatial registration links these two series, and they " +
					"don't share a Frame of Reference."
			);
			this.fusionSelect.value = "none";
			return;
		}

		// Prepare the overlay volume (decode every slice once; cache it).
		this.showMessage("Building fusion volume…", overlay.description || "");
		try {
			const ts = transferSyntaxOf(overlay.slices[0].dataSet);
			if (classifyTransferSyntax(ts) === "jpeg2000") {
				await ensureCodecReady(ts);
			}
			const vol = await this.getVolume(overlay);
			this.overlayVolume = vol;
			this.overlayMatrix = matrix;
			this.overlaySeriesUid = seriesUid;
			this.overlayCenter = vol.defaultCenter;
			this.overlayWidth = vol.defaultWidth;
			// Default to fully showing the fused-in dataset.
			this.overlayOpacity = 1.0;
			if (this.opacityInput) this.opacityInput.value = "100";
		} catch (e) {
			this.showMessage("Could not build fusion volume", String(e));
			return;
		}
		this.hideMessage();
		this.draw();
	}

	private async getVolume(series: Series): Promise<Volume> {
		const cached = this.volumeCache.get(series.seriesUID);
		if (cached) return cached;
		const vol = buildVolume(
			series.slices,
			(s) => decodeFrame(s.dataSet, s.frameIndex),
			series.frameOfReferenceUID
		);
		if (!vol) throw new Error("Series lacks the geometry needed to fuse.");
		// Bound memory: keep at most two built volumes.
		if (this.volumeCache.size >= 2) {
			const oldest = this.volumeCache.keys().next().value as string;
			this.volumeCache.delete(oldest);
		}
		this.volumeCache.set(series.seriesUID, vol);
		return vol;
	}

	/** Resample the overlay onto the current primary slice (cached per slice). */
	private overlayForCurrentSlice(): ResampledPlane | null {
		if (!this.overlayVolume || !this.overlayMatrix || !this.series) {
			return null;
		}
		const cached = this.overlayCache.get(this.sliceIndex);
		if (cached) return cached;

		const ref = this.series.slices[this.sliceIndex];
		const dec = this.current;
		if (!ref.position || !ref.orientation || !dec) return null;
		const ps = dec.pixelSpacing ?? [1, 1];
		const geom: PlaneGeometry = {
			ipp: ref.position,
			xr: ref.orientation.slice(0, 3),
			xc: ref.orientation.slice(3, 6),
			psRow: ps[0],
			psCol: ps[1],
			cols: dec.width,
			rows: dec.height,
		};
		const plane = resamplePlane(geom, this.overlayVolume, this.overlayMatrix);
		if (this.overlayCache.size > DECODE_CACHE_SIZE) this.overlayCache.clear();
		this.overlayCache.set(this.sliceIndex, plane);
		return plane;
	}

	// ---- series list UI -------------------------------------------------------
	private seriesLabel(s: Series): string {
		const custom = this.seriesLabels.get(s.seriesUID);
		if (custom) return custom;
		return (
			(s.seriesNumber ? `${s.seriesNumber}. ` : "") +
			(s.description || "(no description)")
		);
	}

	private populateSeriesList() {
		const list = this.seriesListEl;
		list.empty();
		if (this.allSeries.length === 0) {
			list.createDiv({ cls: "dicom-series-empty", text: "—" });
			return;
		}
		this.allSeries.forEach((s, i) => {
			const row = list.createDiv({ cls: "dicom-series-row" });
			row.dataset.index = String(i);
			const top = [s.modality, `${s.slices.length} sl`]
				.filter(Boolean)
				.join(" · ");
			row.createDiv({ cls: "dicom-series-row-top", text: top });
			const desc = row.createDiv({
				cls: "dicom-series-row-desc",
				text: this.seriesLabel(s),
			});
			desc.title = "Double-click to rename";
			this.registerDomEvent(row, "click", () => {
				if (this.series !== s) this.selectSeries(i);
			});
			// Double-click the description to rename (persisted in the note).
			this.registerDomEvent(desc, "dblclick", (e) => {
				e.stopPropagation();
				this.beginEditLabel(s, desc);
			});
		});
	}

	private beginEditLabel(s: Series, descEl: HTMLElement) {
		const input = createEl("input", {
			type: "text",
			cls: "dicom-series-edit",
			value: this.seriesLabels.get(s.seriesUID) ?? s.description ?? "",
		});
		descEl.replaceWith(input);
		input.focus();
		input.select();
		const commit = (save: boolean) => {
			const val = input.value.trim();
			if (save) {
				if (val) this.seriesLabels.set(s.seriesUID, val);
				else this.seriesLabels.delete(s.seriesUID);
				this.persistSeriesLabels();
			}
			this.populateSeriesList();
			const idx = this.allSeries.indexOf(this.series as Series);
			if (idx >= 0) this.highlightSeries(idx);
			this.updateOverlays();
		};
		this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				commit(false);
			}
			e.stopPropagation();
		});
		this.registerDomEvent(input, "blur", () => commit(true));
		this.registerDomEvent(input, "click", (e) => e.stopPropagation());
	}

	/** Read custom series labels from the pointer note's frontmatter. */
	private loadSeriesLabels() {
		this.seriesLabels.clear();
		if (!this.notePath) return;
		const fm =
			this.app.metadataCache.getCache(this.notePath)?.frontmatter;
		const labels = fm?.["dicom_series_labels"];
		if (labels && typeof labels === "object") {
			for (const [uid, label] of Object.entries(
				labels as Record<string, unknown>
			)) {
				if (typeof label === "string") this.seriesLabels.set(uid, label);
			}
		}
	}

	/** Persist custom labels into the pointer note's YAML frontmatter. */
	private persistSeriesLabels() {
		if (!this.notePath) {
			new Notice(
				"Open this set through its DICOM note to save renamed series."
			);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(this.notePath);
		if (!(file instanceof TFile)) return;
		const obj: Record<string, string> = {};
		for (const [uid, label] of this.seriesLabels) obj[uid] = label;
		this.app.fileManager.processFrontMatter(file, (fm) => {
			if (Object.keys(obj).length) fm["dicom_series_labels"] = obj;
			else delete fm["dicom_series_labels"];
		});
	}

	private highlightSeries(index: number) {
		const rows = this.seriesListEl.querySelectorAll(".dicom-series-row");
		rows.forEach((r) => {
			const el = r as HTMLElement;
			el.toggleClass("is-active", el.dataset.index === String(index));
		});
	}

	private applySort() {
		if (!this.series) return;
		const activeUid = this.series.seriesUID;
		for (const s of this.allSeries) sortSeries(s, this.sortMode);
		// Keep showing the same series; reset to its middle slice.
		const idx = this.allSeries.findIndex((s) => s.seriesUID === activeUid);
		this.decodeCache.clear();
		this.volumeCache.clear(); // slice order changed → volumes must rebuild
		this.resetOverlay();
		this.populateFusionOptions();
		this.sliceIndex = Math.floor(this.series.slices.length / 2);
		try {
			this.current = this.getDecoded(this.sliceIndex);
		} catch {
			/* keep previous */
		}
		this.highlightSeries(idx);
		this.render();
	}

	private releaseSeries() {
		this.series = null;
		this.allSeries = [];
		this.current = null;
		this.decodeCache.clear();
		this.overlaySeriesUid = null;
		this.overlayVolume = null;
		this.overlayMatrix = null;
		this.overlayCache.clear();
		this.volumeCache.clear();
		if (this.seriesListEl) this.seriesListEl.empty();
	}

	// ---- decoding cache -------------------------------------------------------
	private getDecoded(index: number): DecodedSlice {
		const cached = this.decodeCache.get(index);
		if (cached) {
			// refresh LRU position
			this.decodeCache.delete(index);
			this.decodeCache.set(index, cached);
			return cached;
		}
		const ref = this.series!.slices[index];
		const decoded = decodeFrame(ref.dataSet, ref.frameIndex);
		this.decodeCache.set(index, decoded);
		while (this.decodeCache.size > DECODE_CACHE_SIZE) {
			const oldest = this.decodeCache.keys().next().value as number;
			this.decodeCache.delete(oldest);
		}
		return decoded;
	}

	// ---- rendering ------------------------------------------------------------
	/** Re-window the current slice into the offscreen buffer, then composite. */
	private render() {
		if (!this.current) return;
		const slice = this.current;
		this.offscreen.width = slice.width;
		this.offscreen.height = slice.height;
		const imageData = windowToImageData(
			slice,
			this.windowCenter,
			this.windowWidth
		);
		this.offctx.putImageData(imageData, 0, 0);
		this.draw();
	}

	/** Composite the offscreen buffer onto the visible canvas with zoom/pan. */
	private draw() {
		const dpr = window.devicePixelRatio || 1;
		const cssW = this.stage.clientWidth;
		const cssH = this.stage.clientHeight;
		if (cssW === 0 || cssH === 0) return;

		this.canvas.width = Math.round(cssW * dpr);
		this.canvas.height = Math.round(cssH * dpr);
		const ctx = this.ctx;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, cssW, cssH);

		if (!this.current) return;
		const iw = this.current.width;
		const ih = this.current.height;
		const base = Math.min(cssW / iw, cssH / ih);
		const scale = base * this.zoom;
		const drawW = iw * scale;
		const drawH = ih * scale;
		const ox = (cssW - drawW) / 2 + this.panX;
		const oy = (cssH - drawH) / 2 + this.panY;

		ctx.imageSmoothingEnabled = this.zoom <= 1; // crisp pixels when zoomed in
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(this.offscreen, ox, oy, drawW, drawH);

		// Fusion overlay, resampled onto this primary slice via registration.
		const plane = this.overlayForCurrentSlice();
		if (plane) {
			this.paintOverlay(plane, iw, ih);
			ctx.drawImage(this.overlayCanvas, ox, oy, drawW, drawH);
		}

		this.updateOverlays();
	}

	/** Colour-map + alpha the resampled overlay into overlayCanvas. */
	private paintOverlay(plane: ResampledPlane, w: number, h: number) {
		this.overlayCanvas.width = w;
		this.overlayCanvas.height = h;
		const img = new ImageData(w, h);
		const out = img.data;
		const { values, mask } = plane;
		const c = this.overlayCenter;
		const ww = Math.max(this.overlayWidth, 1);
		const lo = c - 0.5 - (ww - 1) / 2;
		const scale = 1 / (ww - 1);
		const alpha = Math.round(this.overlayOpacity * 255);
		const cmap = COLORMAPS[this.overlayColormap] ?? COLORMAPS.hot;

		for (let i = 0; i < values.length; i++) {
			const k = i * 4;
			if (!mask[i]) {
				out[k + 3] = 0;
				continue;
			}
			let t = (values[i] - lo) * scale;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			const rgb = cmap(t);
			out[k] = rgb[0];
			out[k + 1] = rgb[1];
			out[k + 2] = rgb[2];
			out[k + 3] = alpha;
		}
		this.overlayCtx.putImageData(img, 0, 0);
	}

	private updateOverlays() {
		if (!this.series || !this.current) return;
		const s = this.series;
		const idx = this.sliceIndex;
		const n = s.slices.length;
		const ref = s.slices[idx];

		const tl: string[] = [];
		if (s.patientName) tl.push(s.patientName);
		const modLine = [s.modality, s.description]
			.filter(Boolean)
			.join("  ·  ");
		if (modLine) tl.push(modLine);
		this.overlayTL.setText(tl.join("\n"));

		this.overlayTR.setText(
			`Slice ${idx + 1} / ${n}` +
				(ref.frameIndex > 0 || s.slices.some((x) => x.frameIndex > 0)
					? `\nframe ${ref.frameIndex + 1}`
					: `\n#${ref.instanceNumber}`)
		);

		let bl =
			`W: ${Math.round(this.windowWidth)}  L: ${Math.round(
				this.windowCenter
			)}` + (this.isCT ? " HU" : "");
		if (this.overlaySeriesUid && this.overlayVolume) {
			const ov = this.allSeries.find(
				(s) => s.seriesUID === this.overlaySeriesUid
			);
			const ovDesc = ov
				? this.seriesLabels.get(ov.seriesUID) ?? ov.description ?? ""
				: "";
			bl +=
				`\nfuse: ${ov?.modality || ""} ${ovDesc} ${Math.round(
					this.overlayOpacity * 100
				)}%`.trimEnd();
		}
		this.overlayBL.setText(bl);
		this.syncWLInputs();

		const dims = `${this.current.width}×${this.current.height}`;
		const spacing = this.current.pixelSpacing
			? `${this.current.pixelSpacing[0].toFixed(2)} mm`
			: "";
		this.overlayBR.setText(
			[`${dims}`, spacing, `${Math.round(this.zoom * 100)}%`]
				.filter(Boolean)
				.join("\n")
		);

		// Scrollbar thumb position/size.
		const frac = n > 1 ? idx / (n - 1) : 0;
		const thumbH = Math.max(8, 100 / n);
		this.scrollThumb.style.height = `${thumbH}%`;
		this.scrollThumb.style.top = `${frac * (100 - thumbH)}%`;
	}

	// ---- interactions ---------------------------------------------------------
	private registerInteractions() {
		const el = this.stage;

		this.registerDomEvent(el, "wheel", (e: WheelEvent) => {
			if (!this.series) return;
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				this.applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e);
			} else {
				this.changeSlice(e.deltaY > 0 ? 1 : -1);
			}
		});

		this.registerDomEvent(el, "mousedown", (e: MouseEvent) => {
			if (!this.series) return;
			el.focus();
			if (e.button === 1) {
				this.dragMode = "pan"; // middle button always pans
			} else if (e.button === 0) {
				if (e.altKey || e.metaKey) {
					// Alt / Cmd: window-level the fused-in (overlay) dataset.
					this.dragMode = "windowing-overlay";
				} else if (e.ctrlKey || e.shiftKey) {
					// Ctrl / Shift: pan.
					this.dragMode = "pan";
				} else {
					this.dragMode = "windowing"; // reference dataset
				}
			} else {
				return;
			}
			this.lastX = e.clientX;
			this.lastY = e.clientY;
			e.preventDefault();
		});

		this.registerDomEvent(window, "mousemove", (e: MouseEvent) => {
			if (this.dragMode === "none") return;
			const dx = e.clientX - this.lastX;
			const dy = e.clientY - this.lastY;
			this.lastX = e.clientX;
			this.lastY = e.clientY;

			if (this.dragMode === "windowing") {
				const step = Math.max(1, this.windowWidth / 256);
				this.windowWidth = Math.max(1, this.windowWidth + dx * step);
				this.windowCenter += dy * step;
				this.render();
			} else if (this.dragMode === "windowing-overlay") {
				if (!this.overlaySeriesUid) return;
				const step = Math.max(1, this.overlayWidth / 256);
				this.overlayWidth = Math.max(1, this.overlayWidth + dx * step);
				this.overlayCenter += dy * step;
				this.draw(); // recolours overlay; no resample needed
			} else if (this.dragMode === "pan") {
				this.panX += dx;
				this.panY += dy;
				this.draw();
			}
		});

		this.registerDomEvent(window, "mouseup", () => {
			this.dragMode = "none";
		});

		this.registerDomEvent(el, "dblclick", () => {
			this.zoom = 1;
			this.panX = 0;
			this.panY = 0;
			this.draw();
		});

		this.registerDomEvent(el, "keydown", (e: KeyboardEvent) => {
			if (!this.series) return;
			// Ctrl/Cmd+A: invert the fusion opacity (Eclipse-style toggle).
			if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
				e.preventDefault();
				this.invertFusionOpacity();
				return;
			}
			switch (e.key) {
				case "ArrowUp":
				case "ArrowLeft":
					this.changeSlice(-1);
					e.preventDefault();
					break;
				case "ArrowDown":
				case "ArrowRight":
					this.changeSlice(1);
					e.preventDefault();
					break;
				case "PageUp":
					this.changeSlice(-10);
					e.preventDefault();
					break;
				case "PageDown":
					this.changeSlice(10);
					e.preventDefault();
					break;
				case "Home":
					this.goToSlice(0);
					e.preventDefault();
					break;
				case "End":
					this.goToSlice(this.series.slices.length - 1);
					e.preventDefault();
					break;
			}
		});
	}

	private changeSlice(delta: number) {
		this.goToSlice(this.sliceIndex + delta);
	}

	private goToSlice(index: number) {
		if (!this.series) return;
		const n = this.series.slices.length;
		const next = Math.max(0, Math.min(n - 1, index));
		if (next === this.sliceIndex && this.current) return;
		this.sliceIndex = next;
		try {
			this.current = this.getDecoded(next);
		} catch (e) {
			console.warn("DICOM Viewer: decode failed for slice", next, e);
			return;
		}
		this.render();
	}

	private applyZoom(factor: number, e: MouseEvent) {
		const rect = this.canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const cssW = this.stage.clientWidth;
		const cssH = this.stage.clientHeight;
		if (!this.current) return;

		const iw = this.current.width;
		const ih = this.current.height;
		const base = Math.min(cssW / iw, cssH / ih);
		const oldScale = base * this.zoom;
		const oxOld = (cssW - iw * oldScale) / 2 + this.panX;
		const oyOld = (cssH - ih * oldScale) / 2 + this.panY;
		const u = (mx - oxOld) / oldScale;
		const v = (my - oyOld) / oldScale;

		this.zoom = Math.max(0.2, Math.min(20, this.zoom * factor));
		const newScale = base * this.zoom;
		const oxNew = mx - u * newScale;
		const oyNew = my - v * newScale;
		this.panX = oxNew - (cssW - iw * newScale) / 2;
		this.panY = oyNew - (cssH - ih * newScale) / 2;
		this.draw();
	}

	resetAll() {
		if (this.current) {
			this.windowCenter = this.current.defaultCenter;
			this.windowWidth = this.current.defaultWidth;
		}
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		this.render();
	}

	// ---- window/level presets -------------------------------------------------
	private populatePresets() {
		const sel = this.presetSelect;
		sel.empty();
		const add = (value: string, label: string) =>
			sel.createEl("option", { value, text: label });
		add("default", "Default (header)");
		add("full", "Full range");
		if (this.isCT) {
			for (const p of CT_PRESETS) {
				add(p.key, `${p.name} (${p.w}/${p.l})`);
			}
		}
		add("custom", "Custom");
		sel.value = "default";
	}

	private applyPreset(value: string) {
		if (!this.current) return;
		if (value === "default") {
			this.windowCenter = this.current.defaultCenter;
			this.windowWidth = this.current.defaultWidth;
		} else if (value === "full") {
			this.windowCenter = (this.current.min + this.current.max) / 2;
			this.windowWidth = Math.max(1, this.current.max - this.current.min);
		} else if (value === "custom") {
			return;
		} else {
			const p = CT_PRESETS.find((x) => x.key === value);
			if (p) {
				this.windowWidth = p.w;
				this.windowCenter = p.l;
			}
		}
		this.render();
	}

	private syncWLInputs() {
		// Avoid stomping a value the user is actively typing into.
		if (document.activeElement !== this.wInput) {
			this.wInput.value = String(Math.round(this.windowWidth));
		}
		if (document.activeElement !== this.lInput) {
			this.lInput.value = String(Math.round(this.windowCenter));
		}
	}

	// ---- helpers --------------------------------------------------------------
	private addToolButton(
		bar: HTMLElement,
		label: string,
		onClick: () => void
	) {
		const btn = bar.createEl("button", { text: label });
		this.registerDomEvent(btn, "click", (e) => {
			e.stopPropagation();
			onClick();
		});
	}

	private showMessage(title: string, body: string) {
		this.messageEl.empty();
		this.messageEl.createDiv({ cls: "dicom-message-title", text: title });
		if (body) this.messageEl.createDiv({ text: body });
		this.messageEl.show();
	}

	private hideMessage() {
		this.messageEl.hide();
	}
}

// =============================================================================
// FileView wrapper — opens when a .dcm file is clicked or a folder is opened.
// =============================================================================
export class DicomView extends FileView {
	private plugin: DicomViewerPlugin;
	private renderer: DicomRenderer | null = null;
	private folderTitle: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DicomViewerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_DICOM;
	}
	getDisplayText() {
		if (this.file) return this.file.basename;
		return this.folderTitle ?? "DICOM";
	}
	getIcon() {
		return "scan";
	}
	canAcceptExtension(extension: string) {
		return isDicomExtension(extension);
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.style.padding = "0";
		this.renderer = new DicomRenderer(this.app, this.contentEl);
		this.addChild(this.renderer); // loads the component (builds the DOM)
	}

	async onLoadFile(file: TFile) {
		// Read the clicked file to learn its series, then show that series first.
		let preferUid: string | undefined;
		try {
			const buf = await this.app.vault.readBinary(file);
			const pf = tryParse(file.path, new Uint8Array(buf));
			if (pf) preferUid = seriesUidOf(pf.dataSet);
		} catch {
			/* ignore */
		}
		const folderPath = file.parent?.path ?? "/";
		this.folderTitle = file.basename;
		await this.renderer?.loadFromFolder(folderPath, preferUid);
	}

	/** Open a whole folder (used by the folder menu / command). */
	async loadFolder(folderPath: string) {
		this.folderTitle = folderPath.split("/").pop() || "DICOM series";
		await this.renderer?.loadFromFolder(folderPath);
	}

	resetAll() {
		this.renderer?.resetAll();
	}
}

// =============================================================================
// Markdown embed / reading-mode render child for `type: dicom` pointer notes.
// =============================================================================
export class DicomRenderChild extends MarkdownRenderChild {
	constructor(
		private appRef: App,
		container: HTMLElement,
		private folderPath: string,
		private notePath?: string
	) {
		super(container);
	}

	onload() {
		const renderer = new DicomRenderer(this.appRef, this.containerEl, {
			compact: true,
			notePath: this.notePath,
		});
		this.addChild(renderer);
		renderer.loadFromFolder(this.folderPath);
	}
}

// =============================================================================
// Modal that prompts for the imported set's name.
// =============================================================================
export class NameModal extends Modal {
	private value: string;
	private resolved = false;

	constructor(
		app: App,
		defaultValue: string,
		private onSubmit: (value: string | null) => void
	) {
		super(app);
		this.value = defaultValue;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Name this DICOM set" });
		const input = contentEl.createEl("input", {
			type: "text",
			value: this.value,
		});
		input.style.width = "100%";
		input.select();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(input.value);
			} else if (e.key === "Escape") {
				this.close();
			}
		});

		const row = contentEl.createDiv({ cls: "modal-button-container" });
		const ok = row.createEl("button", {
			text: "Import",
			cls: "mod-cta",
		});
		ok.addEventListener("click", () => this.submit(input.value));
		const cancel = row.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	private submit(value: string) {
		this.resolved = true;
		this.onSubmit(value.trim() || null);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) this.onSubmit(null);
	}
}

// ---- tiny concurrency pool ----------------------------------------------------
async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let i = 0;
	const runners: Promise<void>[] = [];
	const next = async (): Promise<void> => {
		while (i < items.length) {
			const idx = i++;
			await worker(items[idx]);
		}
	};
	for (let k = 0; k < Math.min(limit, items.length); k++) {
		runners.push(next());
	}
	await Promise.all(runners);
}
