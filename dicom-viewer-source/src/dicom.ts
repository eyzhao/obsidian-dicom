/*
 * dicom.ts — self-contained DICOM parsing, pixel decoding, window/level, and
 * series assembly. No Obsidian dependencies so it can be unit-tested in isolation.
 *
 * Scope of this minimal version:
 *   - Uncompressed transfer syntaxes (Implicit VR LE, Explicit VR LE/BE).
 *   - 8/16-bit grayscale (MONOCHROME1/2) with Rescale Slope/Intercept (e.g. CT HU).
 *   - RGB / YBR_FULL color (interleaved or planar).
 *   - Single-frame files combined into a series, OR a multi-frame file.
 * Compressed pixel data (JPEG / JPEG2000 / RLE) is detected and reported, not decoded.
 */

import {
	parseDicom,
	DataSet,
	Element,
	readEncapsulatedImageFrame,
	createJPEGBasicOffsetTable,
} from "dicom-parser";
import {
	decodeJpeg2000,
	decodeRLE,
	initJpeg2000,
} from "./codec";

// ---- DICOM tags in dicom-parser's "xggggeeee" lowercase-hex format ------------
const TAG = {
	transferSyntax: "x00020010",
	sopClassUID: "x00080016",
	modality: "x00080060",
	frameOfReferenceUID: "x00200052",
	studyDescription: "x00081030",
	seriesDescription: "x0008103e",
	patientName: "x00100010",
	seriesInstanceUID: "x0020000e",
	seriesNumber: "x00200011",
	instanceNumber: "x00200013",
	imagePosition: "x00200032", // ImagePositionPatient (3 x DS)
	imageOrientation: "x00200037", // ImageOrientationPatient (6 x DS)
	sliceLocation: "x00201041",
	samplesPerPixel: "x00280002",
	photometric: "x00280004",
	planarConfig: "x00280006",
	numberOfFrames: "x00280008",
	rows: "x00280010",
	columns: "x00280011",
	pixelSpacing: "x00280030",
	bitsAllocated: "x00280100",
	bitsStored: "x00280101",
	highBit: "x00280102",
	pixelRepresentation: "x00280103",
	windowCenter: "x00281050",
	windowWidth: "x00281051",
	rescaleIntercept: "x00281052",
	rescaleSlope: "x00281053",
	pixelData: "x7fe00010",
} as const;

const UNCOMPRESSED_TS = new Set([
	"1.2.840.10008.1.2", // Implicit VR Little Endian
	"1.2.840.10008.1.2.1", // Explicit VR Little Endian
	"1.2.840.10008.1.2.2", // Explicit VR Big Endian (deprecated)
]);

// Transfer syntaxes we can decompress.
const JPEG2000_TS = new Set([
	"1.2.840.10008.1.2.4.90", // JPEG 2000 Image Compression (Lossless Only)
	"1.2.840.10008.1.2.4.91", // JPEG 2000 Image Compression
]);
const RLE_TS = "1.2.840.10008.1.2.5"; // RLE Lossless

export type Compression = "none" | "jpeg2000" | "rle" | "unsupported";

export function classifyTransferSyntax(uid: string | undefined): Compression {
	if (!uid || UNCOMPRESSED_TS.has(uid)) return "none";
	if (JPEG2000_TS.has(uid)) return "jpeg2000";
	if (uid === RLE_TS) return "rle";
	return "unsupported";
}

/** True if rendering this series requires the (async) WASM codec to be ready. */
export function needsJpeg2000(uid: string | undefined): boolean {
	return classifyTransferSyntax(uid) === "jpeg2000";
}

export async function ensureCodecReady(uid: string | undefined): Promise<void> {
	if (needsJpeg2000(uid)) await initJpeg2000();
}

export class CompressedDicomError extends Error {
	constructor(public transferSyntax: string | undefined) {
		super(
			"This compressed DICOM transfer syntax is not supported yet" +
				(transferSyntax ? ` (${transferSyntax})` : "")
		);
		this.name = "CompressedDicomError";
	}
}

export interface ParsedFile {
	name: string;
	dataSet: DataSet;
	hasPixelData: boolean;
}

/** Parse a DICOM P10 byte stream. Returns null if it is not a DICOM file. */
export function tryParse(name: string, bytes: Uint8Array): ParsedFile | null {
	try {
		const dataSet = parseDicom(bytes);
		const pix = dataSet.elements[TAG.pixelData];
		return { name, dataSet, hasPixelData: !!pix };
	} catch {
		return null;
	}
}

/** Cheap content sniff: "DICM" magic at byte offset 128 (DICOM Part-10 preamble). */
export function looksLikeDicom(bytes: Uint8Array): boolean {
	return (
		bytes.length > 132 &&
		bytes[128] === 0x44 && // D
		bytes[129] === 0x49 && // I
		bytes[130] === 0x43 && // C
		bytes[131] === 0x4d // M
	);
}

// ---- small readers ------------------------------------------------------------
function floats(ds: DataSet, tag: string, n: number): number[] | null {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const v = ds.floatString(tag, i);
		if (v === undefined || Number.isNaN(v)) return null;
		out.push(v);
	}
	return out;
}

function firstFloat(ds: DataSet, tag: string): number | undefined {
	// WindowCenter/Width may be multi-valued ("40\\400"); take the first.
	const v = ds.floatString(tag, 0);
	return v === undefined || Number.isNaN(v) ? undefined : v;
}

/** Extract the compressed codestream for one frame of encapsulated PixelData. */
function getEncodedFrame(
	ds: DataSet,
	pixelEl: Element,
	frameIndex: number
): Uint8Array {
	const bot = createJPEGBasicOffsetTable(ds, pixelEl);
	const frame = readEncapsulatedImageFrame(ds, pixelEl, frameIndex, bot);
	// Normalise to a plain Uint8Array (could be a Buffer under Node).
	return frame instanceof Uint8Array ? frame : new Uint8Array(frame);
}

// ---- decoded slice ------------------------------------------------------------
export interface DecodedSlice {
	width: number;
	height: number;
	isColor: boolean;
	/** Display-ready RGB, length w*h*3, present when isColor. */
	rgb?: Uint8ClampedArray;
	/** Modality-rescaled grayscale values (e.g. Hounsfield units), length w*h. */
	values?: Float32Array;
	min: number;
	max: number;
	monochrome1: boolean;
	defaultCenter: number;
	defaultWidth: number;
	pixelSpacing?: [number, number]; // [row mm, col mm]
}

function readUint16(b: Uint8Array, p: number, bigEndian: boolean): number {
	return bigEndian ? (b[p] << 8) | b[p + 1] : b[p] | (b[p + 1] << 8);
}

/**
 * Decode one frame to a DecodedSlice. `frameIndex` selects the frame for
 * multi-frame objects (0 for ordinary single-frame files).
 */
export function decodeFrame(ds: DataSet, frameIndex = 0): DecodedSlice {
	const transfer = ds.string(TAG.transferSyntax);
	const pixelEl: Element | undefined = ds.elements[TAG.pixelData];
	if (!pixelEl) throw new Error("No PixelData element");
	const compression = classifyTransferSyntax(transfer);
	if (compression === "unsupported") {
		throw new CompressedDicomError(transfer);
	}

	const rows = ds.uint16(TAG.rows) ?? 0;
	const cols = ds.uint16(TAG.columns) ?? 0;
	if (!rows || !cols) throw new Error("Missing Rows/Columns");

	const samples = ds.uint16(TAG.samplesPerPixel) ?? 1;
	const photometric = (ds.string(TAG.photometric) ?? "MONOCHROME2").trim();
	let planar = ds.uint16(TAG.planarConfig) ?? 0;
	const bitsAllocated = ds.uint16(TAG.bitsAllocated) ?? 16;
	const bitsStored = ds.uint16(TAG.bitsStored) ?? bitsAllocated;
	const pixelRep = ds.uint16(TAG.pixelRepresentation) ?? 0; // 0 unsigned, 1 signed
	const slope = firstFloat(ds, TAG.rescaleSlope) ?? 1;
	const intercept = firstFloat(ds, TAG.rescaleIntercept) ?? 0;

	const ps = floats(ds, TAG.pixelSpacing, 2);
	const pixelSpacing = ps ? ([ps[0], ps[1]] as [number, number]) : undefined;

	const bytesPerSample = bitsAllocated >> 3;
	const numPixels = rows * cols;

	// Obtain the raw (decompressed) pixel bytes for this frame as a Uint8Array
	// whose layout matches an uncompressed frame: little-endian samples, either
	// interleaved (RGB) or contiguous (grayscale).
	let b: Uint8Array;
	let start = 0;
	let bigEndian = false;

	if (compression === "none") {
		bigEndian = transfer === "1.2.840.10008.1.2.2";
		const frameBytes = numPixels * samples * bytesPerSample;
		start = pixelEl.dataOffset + frameIndex * frameBytes;
		b = ds.byteArray;
		if (start + frameBytes > b.length) {
			throw new Error("Frame index out of range / truncated PixelData");
		}
	} else if (compression === "jpeg2000") {
		const encoded = getEncodedFrame(ds, pixelEl, frameIndex);
		const frame = decodeJpeg2000(encoded);
		b = frame.pixels; // little-endian, 1 or 2 bytes/sample
		// JPEG 2000 output is interleaved by sample; treat as planar config 0.
		if (frame.componentCount > 1) planar = 0;
	} else {
		// RLE Lossless
		const encoded = getEncodedFrame(ds, pixelEl, frameIndex);
		b = decodeRLE(encoded, rows, cols, samples, bitsAllocated);
		planar = 0; // decodeRLE outputs interleaved little-endian
	}

	// ---- color ----------------------------------------------------------------
	if (samples === 3) {
		const rgb = new Uint8ClampedArray(numPixels * 3);
		const isYBR = photometric.startsWith("YBR");
		for (let i = 0; i < numPixels; i++) {
			let r: number, g: number, bl: number;
			if (planar === 1) {
				r = b[start + i];
				g = b[start + numPixels + i];
				bl = b[start + 2 * numPixels + i];
			} else {
				const o = start + i * 3;
				r = b[o];
				g = b[o + 1];
				bl = b[o + 2];
			}
			if (isYBR) {
				// YBR_FULL -> RGB (ITU-R BT.601)
				const y = r,
					cb = g - 128,
					cr = bl - 128;
				r = y + 1.402 * cr;
				g = y - 0.344136 * cb - 0.714136 * cr;
				bl = y + 1.772 * cb;
			}
			const j = i * 3;
			rgb[j] = r;
			rgb[j + 1] = g;
			rgb[j + 2] = bl;
		}
		return {
			width: cols,
			height: rows,
			isColor: true,
			rgb,
			min: 0,
			max: 255,
			monochrome1: false,
			defaultCenter: 128,
			defaultWidth: 256,
			pixelSpacing,
		};
	}

	// ---- grayscale ------------------------------------------------------------
	const values = new Float32Array(numPixels);
	let min = Infinity;
	let max = -Infinity;
	const signBit = 1 << (bitsStored - 1);
	const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;

	if (bitsAllocated === 8) {
		for (let i = 0; i < numPixels; i++) {
			let v = b[start + i] & mask;
			if (pixelRep === 1 && v & signBit) v -= 1 << bitsStored;
			const m = v * slope + intercept;
			values[i] = m;
			if (m < min) min = m;
			if (m > max) max = m;
		}
	} else {
		// 16-bit (most CT/MR)
		for (let i = 0; i < numPixels; i++) {
			let v = readUint16(b, start + (i << 1), bigEndian) & mask;
			if (pixelRep === 1 && v & signBit) v -= 1 << bitsStored;
			const m = v * slope + intercept;
			values[i] = m;
			if (m < min) min = m;
			if (m > max) max = m;
		}
	}
	if (!Number.isFinite(min)) {
		min = 0;
		max = 0;
	}

	// Default window: header value if present, else full data range.
	let dc = firstFloat(ds, TAG.windowCenter);
	let dw = firstFloat(ds, TAG.windowWidth);
	if (dc === undefined || dw === undefined || dw <= 0) {
		dc = (min + max) / 2;
		dw = Math.max(max - min, 1);
	}

	return {
		width: cols,
		height: rows,
		isColor: false,
		values,
		min,
		max,
		monochrome1: photometric === "MONOCHROME1",
		defaultCenter: dc,
		defaultWidth: dw,
		pixelSpacing,
	};
}

/** Apply a linear VOI LUT (window/level) and produce canvas ImageData. */
export function windowToImageData(
	slice: DecodedSlice,
	center: number,
	width: number
): ImageData {
	const { width: w, height: h } = slice;
	const out = new Uint8ClampedArray(w * h * 4);

	if (slice.isColor && slice.rgb) {
		const rgb = slice.rgb;
		for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 3, k += 4) {
			out[k] = rgb[j];
			out[k + 1] = rgb[j + 1];
			out[k + 2] = rgb[j + 2];
			out[k + 3] = 255;
		}
		return new ImageData(out, w, h);
	}

	const values = slice.values!;
	const ww = Math.max(width, 1);
	const wc = center;
	const lo = wc - 0.5 - (ww - 1) / 2;
	const hi = wc - 0.5 + (ww - 1) / 2;
	const scale = 255 / (ww - 1);
	const mono1 = slice.monochrome1;

	for (let i = 0, k = 0; i < values.length; i++, k += 4) {
		const x = values[i];
		let y: number;
		if (x <= lo) y = 0;
		else if (x > hi) y = 255;
		else y = (x - (wc - 0.5)) * scale + 127.5;
		if (mono1) y = 255 - y;
		const yc = y < 0 ? 0 : y > 255 ? 255 : y | 0;
		out[k] = yc;
		out[k + 1] = yc;
		out[k + 2] = yc;
		out[k + 3] = 255;
	}
	return new ImageData(out, w, h);
}

// ---- series assembly ----------------------------------------------------------
export type SortMode = "position" | "instance" | "filename";

export interface SliceRef {
	dataSet: DataSet;
	frameIndex: number;
	instanceNumber: number;
	sortPos: number; // signed distance along the common series normal
	sourceName: string;
	position: number[] | null; // ImagePositionPatient, if present
	orientation: number[] | null; // ImageOrientationPatient, if present
}

export interface Series {
	seriesUID: string;
	seriesNumber: number;
	description: string;
	modality: string;
	patientName: string;
	frameOfReferenceUID?: string;
	slices: SliceRef[];
}

function cross(a: number[], b: number[]): number[] {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

/**
 * Group parsed image files into series (by SeriesInstanceUID), project each
 * slice onto a single shared normal so interleaved-acquisition series end up in
 * true anatomical order, and sort. Multi-frame files expand to one ref/frame.
 */
export function buildSeries(files: ParsedFile[]): Series[] {
	const groups = new Map<string, Series>();

	for (const f of files) {
		if (!f.hasPixelData) continue;
		const ds = f.dataSet;
		const seriesUID =
			ds.string(TAG.seriesInstanceUID) ?? `__nouid__${f.name}`;
		let series = groups.get(seriesUID);
		if (!series) {
			series = {
				seriesUID,
				seriesNumber: ds.intString(TAG.seriesNumber, 0) ?? 0,
				description:
					ds.string(TAG.seriesDescription) ??
					ds.string(TAG.studyDescription) ??
					"",
				modality: ds.string(TAG.modality) ?? "",
				patientName: cleanName(ds.string(TAG.patientName)),
				frameOfReferenceUID: ds.string(TAG.frameOfReferenceUID),
				slices: [],
			};
			groups.set(seriesUID, series);
		}

		const instanceNumber = ds.intString(TAG.instanceNumber, 0) ?? 0;
		const numFrames = ds.intString(TAG.numberOfFrames, 0) ?? 1;
		const orientation = floats(ds, TAG.imageOrientation, 6);
		const position = floats(ds, TAG.imagePosition, 3);

		if (numFrames > 1) {
			for (let fr = 0; fr < numFrames; fr++) {
				series.slices.push({
					dataSet: ds,
					frameIndex: fr,
					instanceNumber,
					sortPos: fr,
					sourceName: f.name,
					position,
					orientation,
				});
			}
		} else {
			series.slices.push({
				dataSet: ds,
				frameIndex: 0,
				instanceNumber,
				sortPos: 0,
				sourceName: f.name,
				position,
				orientation,
			});
		}
	}

	const list = Array.from(groups.values());
	for (const s of list) {
		projectOntoCommonNormal(s);
		sortSeries(s, "position");
	}
	// Largest series first — usually the primary image volume.
	list.sort((a, b) => b.slices.length - a.slices.length);
	return list;
}

/** Compute each slice's sortPos as the projection onto one shared normal. */
function projectOntoCommonNormal(series: Series) {
	// Use the first slice that has an orientation to define the volume normal,
	// so every slice is measured along the same axis (interleaved acquisition,
	// per-slice orientation jitter, etc. no longer scramble the order).
	let normal: number[] | null = null;
	for (const sl of series.slices) {
		if (sl.orientation) {
			normal = cross(
				sl.orientation.slice(0, 3),
				sl.orientation.slice(3, 6)
			);
			break;
		}
	}
	for (const sl of series.slices) {
		if (normal && sl.position) {
			sl.sortPos =
				sl.position[0] * normal[0] +
				sl.position[1] * normal[1] +
				sl.position[2] * normal[2];
		} else {
			const sliceLoc = sl.dataSet.floatString(TAG.sliceLocation, 0);
			sl.sortPos =
				sliceLoc !== undefined && !Number.isNaN(sliceLoc)
					? sliceLoc
					: sl.frameIndex || sl.instanceNumber;
		}
	}
}

/** Re-sort a series in place by the chosen key. */
export function sortSeries(series: Series, mode: SortMode) {
	const cmp: Record<SortMode, (a: SliceRef, b: SliceRef) => number> = {
		position: (a, b) =>
			a.sortPos - b.sortPos ||
			a.instanceNumber - b.instanceNumber ||
			a.frameIndex - b.frameIndex,
		instance: (a, b) =>
			a.instanceNumber - b.instanceNumber ||
			a.frameIndex - b.frameIndex ||
			a.sortPos - b.sortPos,
		filename: (a, b) =>
			a.sourceName.localeCompare(b.sourceName, undefined, {
				numeric: true,
			}) || a.frameIndex - b.frameIndex,
	};
	series.slices.sort(cmp[mode]);
}

function cleanName(raw: string | undefined): string {
	if (!raw) return "";
	// DICOM PN uses "^" to separate name components.
	return raw.replace(/\^+/g, " ").replace(/\s+/g, " ").trim();
}

export function seriesUidOf(ds: DataSet): string | undefined {
	return ds.string(TAG.seriesInstanceUID);
}

export function transferSyntaxOf(ds: DataSet): string | undefined {
	return ds.string(TAG.transferSyntax);
}

export function sopClassOf(ds: DataSet): string | undefined {
	return ds.string(TAG.sopClassUID);
}

export function modalityOf(ds: DataSet): string | undefined {
	return ds.string(TAG.modality);
}
