/*
 * contour.ts — project an RTSTRUCT contour (patient mm, in its own Frame of
 * Reference) onto the displayed slice plane, applying a registration transform
 * so structures defined on e.g. the CT can be drawn on a co-registered MR.
 */

import { Mat4 } from "./registration";

export interface SliceFrame {
	ipp: number[]; // ImagePositionPatient of the displayed slice (display FoR)
	xr: number[]; // row cosines
	xc: number[]; // column cosines
	normal: number[]; // unit slice normal = xr × xc
	psRow: number; // PixelSpacing[0]
	psCol: number; // PixelSpacing[1]
	sliceKey: number; // dot(ipp, normal)
	halfThickness: number; // matching tolerance (mm)
}

function cross(a: number[], b: number[]) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
function norm(a: number[]) {
	const m = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / m, a[1] / m, a[2] / m];
}

export function buildSliceFrame(
	ipp: number[],
	xr: number[],
	xc: number[],
	psRow: number,
	psCol: number,
	halfThickness: number
): SliceFrame {
	const normal = norm(cross(xr, xc));
	return {
		ipp,
		xr,
		xc,
		normal,
		psRow,
		psCol,
		sliceKey: ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2],
		halfThickness,
	};
}

function tx(M: Mat4, x: number, y: number, z: number, out: number[]) {
	out[0] = M[0] * x + M[1] * y + M[2] * z + M[3];
	out[1] = M[4] * x + M[5] * y + M[6] * z + M[7];
	out[2] = M[8] * x + M[9] * y + M[10] * z + M[11];
}

/**
 * If the contour lies on the given slice (after applying M: structFoR→displayFoR),
 * return its vertices as a flat [j0,i0, j1,i1, …] array in pixel coordinates;
 * otherwise return null.
 */
export function contourOnSlice(
	points: Float32Array,
	M: Mat4,
	f: SliceFrame
): number[] | null {
	if (points.length < 9) return null; // need ≥3 points
	const p = [0, 0, 0];

	// Depth test using the first vertex (planar contours are coplanar).
	tx(M, points[0], points[1], points[2], p);
	const depth = p[0] * f.normal[0] + p[1] * f.normal[1] + p[2] * f.normal[2];
	if (Math.abs(depth - f.sliceKey) > f.halfThickness) return null;

	const n = points.length / 3;
	const out = new Array(n * 2);
	for (let k = 0; k < n; k++) {
		tx(M, points[k * 3], points[k * 3 + 1], points[k * 3 + 2], p);
		const rx = p[0] - f.ipp[0];
		const ry = p[1] - f.ipp[1];
		const rz = p[2] - f.ipp[2];
		// column index j (row direction), row index i (column direction)
		out[k * 2] =
			(rx * f.xr[0] + ry * f.xr[1] + rz * f.xr[2]) / f.psCol;
		out[k * 2 + 1] =
			(rx * f.xc[0] + ry * f.xc[1] + rz * f.xc[2]) / f.psRow;
	}
	return out;
}
