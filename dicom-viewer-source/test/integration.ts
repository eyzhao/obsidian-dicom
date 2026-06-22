// test/integration.ts — exercises the real plugin decode path end-to-end.
import * as fs from "fs";
import {
	tryParse,
	decodeFrame,
	windowToImageData,
	ensureCodecReady,
	transferSyntaxOf,
	classifyTransferSyntax,
} from "../src/dicom";
import { decodeRLE } from "../src/codec";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}

(async () => {
	// ---- 1. Real JPEG 2000 file (the user's IM1) ----------------------------
	const bytes = new Uint8Array(fs.readFileSync("/mnt/user-data/uploads/IM1"));
	const pf = tryParse("IM1", bytes)!;
	const ts = transferSyntaxOf(pf.dataSet);
	check("IM1 classified as jpeg2000", classifyTransferSyntax(ts) === "jpeg2000", String(ts));

	await ensureCodecReady(ts); // loads inlined-wasm OpenJPEG
	const slice = decodeFrame(pf.dataSet, 0);
	check("IM1 decodes to 512x512", slice.width === 512 && slice.height === 512,
		`${slice.width}x${slice.height}`);
	check("IM1 is grayscale", slice.isColor === false);
	check("IM1 has pixel values", !!slice.values && slice.values.length === 512 * 512);
	check("IM1 header window center 121", Math.round(slice.defaultCenter) === 121,
		String(slice.defaultCenter));
	check("IM1 header window width 292", Math.round(slice.defaultWidth) === 292,
		String(slice.defaultWidth));
	check("IM1 value range plausible (max>100)", slice.max > 100,
		`min ${slice.min} max ${slice.max}`);

	// Windowing produces a non-empty image with varied gray levels.
	const img = windowToImageData(slice, slice.defaultCenter, slice.defaultWidth);
	let nonBlack = 0;
	const seen = new Set<number>();
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i] > 0) nonBlack++;
		seen.add(img.data[i]);
	}
	check("windowed image has visible pixels", nonBlack > 1000, `${nonBlack} non-black`);
	check("windowed image has gray gradient (not 1-bit)", seen.size > 20, `${seen.size} levels`);

	// ---- 2. Synthetic RLE round-trip (16-bit mono) --------------------------
	// Build a tiny 2x2 16-bit image, RLE-encode it by hand, decode, compare.
	// Pixels (LE): values 0x0102, 0x0304, 0x0506, 0x0708
	// 16-bit RLE => 2 segments: segment0 = MSB bytes, segment1 = LSB bytes.
	const msb = [0x01, 0x03, 0x05, 0x07];
	const lsb = [0x02, 0x04, 0x06, 0x08];
	// PackBits literal run: control = n-1 then n bytes; here 4 bytes => control 3.
	const seg = (arr: number[]) => [3, ...arr];
	const seg0 = seg(msb), seg1 = seg(lsb);
	const headerLen = 64;
	const off0 = headerLen;
	const off1 = headerLen + seg0.length;
	const header = new Uint8Array(64);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, 2, true); // 2 segments
	hv.setUint32(4, off0, true);
	hv.setUint32(8, off1, true);
	const rle = new Uint8Array([...header, ...seg0, ...seg1]);
	const out = decodeRLE(rle, 2, 2, 1, 16);
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const got = [0, 1, 2, 3].map((i) => dv.getUint16(i * 2, true));
	check("RLE 16-bit decode correct", JSON.stringify(got) === JSON.stringify([0x0102, 0x0304, 0x0506, 0x0708]),
		JSON.stringify(got.map((x) => x.toString(16))));

	console.log(failures === 0 ? "\nALL INTEGRATION TESTS PASSED" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("ERROR:", e);
	process.exit(1);
});
