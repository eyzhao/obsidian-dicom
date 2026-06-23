// test/contour.ts — verify contour-to-slice projection and depth matching.
import { buildSliceFrame, contourOnSlice } from "../src/contour";
import { identity4 } from "../src/registration";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}
const approx = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

// Axial slice at z=10: ipp=[0,0,10], xr=[1,0,0], xc=[0,1,0], 1mm pixels.
const frame = buildSliceFrame([0, 0, 10], [1, 0, 0], [0, 1, 0], 1, 1, 1.5);
check("sliceKey = 10", approx(frame.sliceKey, 10), String(frame.sliceKey));
check("normal = +z", approx(frame.normal[2], 1));

// A square contour on z=10 at patient (5,5)-(15,15).
const onPlane = new Float32Array([
	5, 5, 10, 15, 5, 10, 15, 15, 10, 5, 15, 10,
]);
const poly = contourOnSlice(onPlane, identity4(), frame);
check("contour on plane returns polygon", !!poly && poly.length === 8);
if (poly) {
	// patient (5,5,10) -> pixel (j=5,i=5); (15,15,10) -> (15,15)
	check("vertex0 maps to (5,5)", approx(poly[0], 5) && approx(poly[1], 5), `${poly[0]},${poly[1]}`);
	check("vertex2 maps to (15,15)", approx(poly[4], 15) && approx(poly[5], 15), `${poly[4]},${poly[5]}`);
}

// A contour 5mm away in z (outside halfThickness 1.5) → not on this slice.
const offPlane = new Float32Array([5, 5, 15, 15, 5, 15, 15, 15, 15, 5, 15, 15]);
check("off-plane contour rejected", contourOnSlice(offPlane, identity4(), frame) === null);

// A contour 1mm away (within 1.5 tolerance) → still drawn.
const nearPlane = new Float32Array([5, 5, 11, 15, 5, 11, 15, 15, 11, 5, 15, 11]);
check("near-plane (1mm) contour accepted", contourOnSlice(nearPlane, identity4(), frame) !== null);

// With a registration translating struct z by +? : structFoR point at z=10
// mapped by M (z+? ) lands on slice. M translates +0 here but shift x by +3:
import { Mat4 } from "../src/registration";
const M: Mat4 = identity4();
M[3] = 3; // +3mm in x (struct → display)
const shifted = contourOnSlice(onPlane, M, frame);
check("registration x-shift moves pixels by +3", !!shifted && approx(shifted[0], 8),
	shifted ? String(shifted[0]) : "null");

console.log(failures === 0 ? "\nCONTOUR TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
