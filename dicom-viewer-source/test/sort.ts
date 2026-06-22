// test/sort.ts — verifies that a series acquired out of spatial order is sorted
// into true anatomical order by position, and that sort modes work.
import { buildSeries, sortSeries, tryParse, ParsedFile } from "../src/dicom";

function u16(n: number) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function u32(n: number) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]); }
function ascii(s: string) { return new Uint8Array([...s].map((c) => c.charCodeAt(0))); }
function pad(s: string, p = " ") { return s.length % 2 === 0 ? s : s + p; }
function cat(...a: Uint8Array[]) { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; }
function elShort(g: number, e: number, vr: string, v: Uint8Array) { return cat(u16(g), u16(e), ascii(vr), u16(v.length), v); }
function elLong(g: number, e: number, vr: string, v: Uint8Array) { return cat(u16(g), u16(e), ascii(vr), u16(0), u32(v.length), v); }
function S(g: number, e: number, vr: string, s: string) { return elShort(g, e, vr, ascii(pad(s, vr === "UI" ? "\0" : " "))); }
function US(g: number, e: number, n: number) { return elShort(g, e, "US", u16(n)); }

// One axial CT slice at z=`z`, with the given InstanceNumber and filename.
function makeSlice(z: number, instance: number): Uint8Array {
	const pix = new Uint8Array(2 * 2 * 2); // 2x2 16-bit, zeros
	return cat(
		new Uint8Array(128), ascii("DICM"),
		S(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
		S(0x0008, 0x0060, "CS", "CT"),
		S(0x0020, 0x000e, "UI", "1.2.3.SERIES"), // same SeriesInstanceUID
		S(0x0020, 0x0011, "IS", "2"),             // SeriesNumber (IS)
		S(0x0020, 0x0013, "IS", String(instance)),// InstanceNumber
		S(0x0020, 0x0032, "DS", `0\\0\\${z}`),    // ImagePositionPatient
		S(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"), // axial orientation
		US(0x0028, 0x0002, 1),
		S(0x0028, 0x0004, "CS", "MONOCHROME2"),
		US(0x0028, 0x0010, 2), US(0x0028, 0x0011, 2),
		US(0x0028, 0x0100, 16), US(0x0028, 0x0101, 16),
		US(0x0028, 0x0102, 15), US(0x0028, 0x0103, 0),
		elLong(0x7fe0, 0x0010, "OW", pix)
	);
}

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}

// Spatial order is z = 0,1,2,3,4 but acquisition (InstanceNumber) is interleaved
// 1,3,5,2,4 — the classic pattern that produced the scrambled scroll order.
const spec = [
	{ z: 0, inst: 1 },
	{ z: 1, inst: 3 },
	{ z: 2, inst: 5 },
	{ z: 3, inst: 2 },
	{ z: 4, inst: 4 },
];
// Feed them to buildSeries in shuffled order to prove sorting doesn't rely on input order.
const shuffled = [spec[2], spec[0], spec[4], spec[1], spec[3]];
const parsed: ParsedFile[] = shuffled.map((s, i) =>
	tryParse(`IM${i}`, makeSlice(s.z, s.inst))!
);

const series = buildSeries(parsed);
check("single series grouped", series.length === 1, `got ${series.length}`);
const s = series[0];
check("series number read", s.seriesNumber === 2);
check("5 slices", s.slices.length === 5);

// Default position sort => z ascending => instance numbers 1,3,5,2,4
const posOrder = s.slices.map((x) => x.instanceNumber);
check("position sort gives spatial order", JSON.stringify(posOrder) === JSON.stringify([1, 3, 5, 2, 4]),
	JSON.stringify(posOrder));
const zOrder = s.slices.map((x) => x.sortPos);
check("sortPos strictly increasing", zOrder.every((v, i) => i === 0 || v > zOrder[i - 1]),
	JSON.stringify(zOrder));

// Instance-number sort => 1,2,3,4,5
sortSeries(s, "instance");
check("instance sort gives 1..5", JSON.stringify(s.slices.map((x) => x.instanceNumber)) === JSON.stringify([1, 2, 3, 4, 5]));

console.log(failures === 0 ? "\nSORT TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
