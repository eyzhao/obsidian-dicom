/*
 * codec.ts — decoders for compressed DICOM pixel data.
 *
 *  - JPEG 2000 (.90 lossless / .91 lossy) via the OpenJPEG WASM build. The wasm
 *    binary is inlined into the bundle (esbuild "binary" loader) and handed to
 *    the Emscripten module as `wasmBinary`, so there is NO runtime fetch — which
 *    is what lets it work as a single-file Obsidian plugin.
 *  - RLE Lossless (.5) in pure JavaScript (no wasm needed).
 *
 * The WASM module is initialised once, lazily, and the decoder instance is
 * reused across slices. decode() is synchronous once the module is ready, so
 * scrolling stays responsive (decoded slices are also LRU-cached by the view).
 */

// These imports are resolved by esbuild. See types.d.ts for the ambient module
// declarations and esbuild.config.mjs for the ".wasm" binary loader.
// @ts-ignore
import OpenJPEGFactory from "@cornerstonejs/codec-openjpeg/decode";
// @ts-ignore
import openjpegWasmBinary from "@cornerstonejs/codec-openjpeg/decodewasm";

export interface RawFrame {
	pixels: Uint8Array; // raw little-endian bytes (1 or 2 bytes per sample)
	width: number;
	height: number;
	bitsPerSample: number;
	componentCount: number;
	isSigned: boolean;
}

// ---- JPEG 2000 ---------------------------------------------------------------
let openjpegModule: any = null;
let j2kDecoder: any = null;
let initPromise: Promise<void> | null = null;

/** Load the OpenJPEG WASM module once. Safe to call repeatedly. */
export function initJpeg2000(): Promise<void> {
	if (j2kDecoder) return Promise.resolve();
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const wasmBinary =
			openjpegWasmBinary instanceof Uint8Array
				? openjpegWasmBinary
				: new Uint8Array(openjpegWasmBinary);
		openjpegModule = await OpenJPEGFactory({
			wasmBinary,
			// Silence the decoder's verbose stdout/stderr.
			print: () => {},
			printErr: () => {},
		});
		j2kDecoder = new openjpegModule.J2KDecoder();
	})();
	return initPromise;
}

export function isJpeg2000Ready(): boolean {
	return !!j2kDecoder;
}

/** Decode one JPEG 2000 frame. Requires initJpeg2000() to have resolved. */
export function decodeJpeg2000(encoded: Uint8Array): RawFrame {
	if (!j2kDecoder) {
		throw new Error("JPEG 2000 decoder not initialised");
	}
	// Copy the encoded codestream into the wasm heap.
	const inBuf: Uint8Array = j2kDecoder.getEncodedBuffer(encoded.length);
	inBuf.set(encoded);
	j2kDecoder.decode();

	const fi = j2kDecoder.getFrameInfo();
	const decoded: Uint8Array = j2kDecoder.getDecodedBuffer();
	// getDecodedBuffer returns a view into the wasm heap that is valid only until
	// the next decode() — copy it out immediately.
	const pixels = new Uint8Array(decoded.length);
	pixels.set(decoded);

	return {
		pixels,
		width: fi.width,
		height: fi.height,
		bitsPerSample: fi.bitsPerSample,
		componentCount: fi.componentCount,
		isSigned: fi.isSigned,
	};
}

// ---- RLE Lossless (pure JS) --------------------------------------------------
/**
 * Decode DICOM RLE (transfer syntax 1.2.840.10008.1.2.5).
 * Frame layout: 64-byte header (segment count + up to 15 offsets), then
 * PackBits-encoded segments. For N-byte samples the bytes are stored as
 * separate MSB-first segments and must be re-interleaved.
 */
export function decodeRLE(
	encoded: Uint8Array,
	rows: number,
	cols: number,
	samplesPerPixel: number,
	bitsAllocated: number
): Uint8Array {
	const dv = new DataView(
		encoded.buffer,
		encoded.byteOffset,
		encoded.byteLength
	);
	const numSegments = dv.getUint32(0, true);
	const offsets: number[] = [];
	for (let i = 0; i < numSegments; i++) {
		offsets.push(dv.getUint32(4 + i * 4, true));
	}

	const numPixels = rows * cols;
	const bytesPerSample = bitsAllocated >> 3;
	const out = new Uint8Array(numPixels * samplesPerPixel * bytesPerSample);

	// Segment s belongs to sample (s / bytesPerSample) and byte position within
	// that sample (MSB first). Place decoded bytes into the interleaved output.
	for (let s = 0; s < numSegments; s++) {
		const start = offsets[s];
		const end = s + 1 < numSegments ? offsets[s + 1] : encoded.length;
		const plane = unpackBits(encoded, start, end, numPixels);

		const sample = Math.floor(s / bytesPerSample);
		const byteInSample = s % bytesPerSample; // 0 = most significant
		const dstByte = bytesPerSample - 1 - byteInSample; // little-endian output
		const stride = samplesPerPixel * bytesPerSample;
		let dst = sample * bytesPerSample + dstByte;
		for (let p = 0; p < numPixels; p++) {
			out[dst] = plane[p];
			dst += stride;
		}
	}
	return out;
}

function unpackBits(
	src: Uint8Array,
	start: number,
	end: number,
	expected: number
): Uint8Array {
	const out = new Uint8Array(expected);
	let o = 0;
	let i = start;
	while (i < end && o < expected) {
		const n = src[i++];
		if (n === 128) continue; // 0x80 = no-op
		if (n < 128) {
			// copy next n+1 bytes literally
			const count = n + 1;
			for (let k = 0; k < count && i < end && o < expected; k++) {
				out[o++] = src[i++];
			}
		} else {
			// replicate next byte (257 - n) times  => count = 2..128
			const count = 257 - n;
			const val = src[i++];
			for (let k = 0; k < count && o < expected; k++) {
				out[o++] = val;
			}
		}
	}
	return out;
}
