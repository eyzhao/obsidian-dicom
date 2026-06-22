// test/smoke.ts — builds a tiny Explicit-VR-LE CT DICOM in memory and checks
// that decodeFrame() + windowToImageData() produce correct values.
import { decodeFrame, windowToImageData, buildSeries, tryParse } from "../src/dicom";

// ---- minimal DICOM writer (Explicit VR Little Endian) ------------------------
function buf(...arrs: Uint8Array[]): Uint8Array {
	const len = arrs.reduce((a, b) => a + b.length, 0);
	const out = new Uint8Array(len);
	let o = 0;
	for (const a of arrs) {
		out.set(a, o);
		o += a.length;
	}
	return out;
}
function u16(n: number) {
	return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function u32(n: number) {
	return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}
function ascii(s: string) {
	return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}
function pad(s: string, padChar = " ") {
	return s.length % 2 === 0 ? s : s + padChar;
}
// short-form VR (2-byte length)
function elShort(group: number, element: number, vr: string, value: Uint8Array) {
	return buf(u16(group), u16(element), ascii(vr), u16(value.length), value);
}
// long-form VR (OB/OW/etc: 2 reserved + 4-byte length)
function elLong(group: number, element: number, vr: string, value: Uint8Array) {
	return buf(u16(group), u16(element), ascii(vr), u16(0), u32(value.length), value);
}
function str(group: number, element: number, vr: string, s: string) {
	return elShort(group, element, vr, ascii(pad(s, vr === "UI" ? "\0" : " ")));
}
function us(group: number, element: number, n: number) {
	return elShort(group, element, "US", u16(n));
}

// 4x4 16-bit pixels (stored values). HU = stored - 1024.
const stored = [
	864, 1064, 1264, 1024,
	1024, 1064, 1064, 1024,
	500, 1024, 2000, 1024,
	1024, 1024, 1024, 1024,
];
const pixelBytes = new Uint8Array(stored.length * 2);
stored.forEach((v, i) => pixelBytes.set(u16(v), i * 2));

const preamble = new Uint8Array(128);
const dicm = ascii("DICM");
const meta = buf(
	str(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1") // Explicit VR LE
);
const dataset = buf(
	str(0x0008, 0x0060, "CS", "CT"),
	str(0x0020, 0x000e, "UI", "1.2.3.4"),
	str(0x0020, 0x0013, "IS", "1"),
	us(0x0028, 0x0002, 1),
	str(0x0028, 0x0004, "CS", "MONOCHROME2"),
	us(0x0028, 0x0010, 4),
	us(0x0028, 0x0011, 4),
	us(0x0028, 0x0100, 16),
	us(0x0028, 0x0101, 16),
	us(0x0028, 0x0102, 15),
	us(0x0028, 0x0103, 0),
	str(0x0028, 0x1050, "DS", "40"),
	str(0x0028, 0x1051, "DS", "400"),
	str(0x0028, 0x1052, "DS", "-1024"),
	str(0x0028, 0x1053, "DS", "1"),
	elLong(0x7fe0, 0x0010, "OW", pixelBytes)
);
const file = buf(preamble, dicm, meta, dataset);

// ---- run ---------------------------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) console.log(`  ok   ${name}`);
	else {
		console.log(`  FAIL ${name} ${extra}`);
		failures++;
	}
}

const parsed = tryParse("synthetic.dcm", file);
check("parses as DICOM", !!parsed);
check("has pixel data", !!parsed && parsed.hasPixelData);

const decoded = decodeFrame(parsed!.dataSet, 0);
check("dimensions 4x4", decoded.width === 4 && decoded.height === 4);
check("not color", decoded.isColor === false);
check("HU rescale applied (pixel0 = 864-1024 = -160)", decoded.values![0] === -160);
check("HU rescale (pixel10 = 2000-1024 = 976)", decoded.values![10] === 976);
check("min HU = 500-1024 = -524", decoded.min === -524, `got ${decoded.min}`);
check("max HU = 2000-1024 = 976", decoded.max === 976, `got ${decoded.max}`);
check("default center 40 from header", decoded.defaultCenter === 40);
check("default width 400 from header", decoded.defaultWidth === 400);

// window math: center 40, width 400 => low edge -159.5, high edge 239.5
const img = windowToImageData(decoded, 40, 400);
// pixel1 HU=40 -> middle ~ 128
const p1 = img.data[1 * 4];
check("HU 40 maps to mid-gray (~128)", Math.abs(p1 - 128) <= 2, `got ${p1}`);
// pixel0 HU=-160 -> below low edge -> 0
check("HU -160 maps to black", img.data[0] === 0, `got ${img.data[0]}`);
// pixel2 HU=240 -> above high edge -> 255
check("HU 240 maps to white", img.data[2 * 4] === 255, `got ${img.data[2 * 4]}`);
check("alpha channel set", img.data[3] === 255);

// series assembly: two synthetic files, same series, instance order
const series = buildSeries([parsed!, tryParse("synthetic.dcm", file)!]);
check("one series built", series.length === 1, `got ${series.length}`);
check("series modality CT", series[0].modality === "CT");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
