/*
 * volume.ts — assemble a series into a 3D volume and resample it onto an
 * arbitrary slice plane, applying a registration transform. Used for fusion /
 * co-registered overlay display.
 *
 * Coordinate conventions (DICOM patient RCS, millimetres):
 *   pixel (col=j, row=i) of a slice ->
 *     P = IPP + j*PixelSpacing[1]*Xr + i*PixelSpacing[0]*Xc
 *   where Xr = ImageOrientationPatient[0:3] (row cosines, +j direction),
 *         Xc = ImageOrientationPatient[3:6] (column cosines, +i direction),
 *         PixelSpacing = [between-rows (Δi), between-columns (Δj)].
 */

import { DecodedSlice, SliceRef } from "./dicom";
import { Mat4, mat4Inverse, transformPoint } from "./registration";

export interface Volume {
	nx: number; // columns
	ny: number; // rows
	nz: number; // slices
	data: Int16Array; // modality values (rounded), length nx*ny*nz
	invAffine: Mat4; // patient(mm) -> voxel (j,i,k)
	frameOfReferenceUID?: string;
	min: number;
	max: number;
	defaultCenter: number;
	defaultWidth: number;
}

function sub(a: number[], b: number[]) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: number[], b: number[]) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
function clampI16(v: number) {
	v = Math.round(v);
	return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/**
 * Build a regular 3D volume from sorted slices. `decode` returns pixel values
 * for a slice. Requires per-slice ImagePositionPatient + ImageOrientationPatient
 * (returns null if the geometry is missing or inconsistent).
 */
export function buildVolume(
	slices: SliceRef[],
	decode: (s: SliceRef) => DecodedSlice,
	forUID?: string
): Volume | null {
	if (slices.length === 0) return null;
	const first = slices[0];
	if (!first.position || !first.orientation) return null;

	const xr = first.orientation.slice(0, 3);
	const xc = first.orientation.slice(3, 6);
	const ipp0 = first.position;

	const d0 = decode(first);
	const nx = d0.width;
	const ny = d0.height;
	const nz = slices.length;
	const ps = d0.pixelSpacing ?? [1, 1];

	// Inter-slice vector: prefer the actual step between the first two slices;
	// fall back to the slice normal * 1mm for a single slice.
	let sliceVec: number[];
	if (nz > 1 && slices[1].position) {
		sliceVec = sub(slices[1].position!, ipp0);
	} else {
		const n = cross(xr, xc);
		sliceVec = n;
	}

	// Affine A: voxel (j,i,k) -> patient (mm), row-major 4x4.
	const A: Mat4 = [
		xr[0] * ps[1], xc[0] * ps[0], sliceVec[0], ipp0[0],
		xr[1] * ps[1], xc[1] * ps[0], sliceVec[1], ipp0[1],
		xr[2] * ps[1], xc[2] * ps[0], sliceVec[2], ipp0[2],
		0, 0, 0, 1,
	];
	const invAffine = mat4Inverse(A);

	const data = new Int16Array(nx * ny * nz);
	let min = Infinity;
	let max = -Infinity;
	let sumC = 0;
	let sumW = 0;

	for (let k = 0; k < nz; k++) {
		const dec = k === 0 ? d0 : decode(slices[k]);
		const base = k * nx * ny;
		if (dec.values) {
			const v = dec.values;
			for (let p = 0; p < nx * ny; p++) {
				const val = clampI16(v[p]);
				data[base + p] = val;
				if (val < min) min = val;
				if (val > max) max = val;
			}
		} else if (dec.rgb) {
			const rgb = dec.rgb;
			for (let p = 0; p < nx * ny; p++) {
				const lum =
					0.299 * rgb[p * 3] +
					0.587 * rgb[p * 3 + 1] +
					0.114 * rgb[p * 3 + 2];
				const val = clampI16(lum);
				data[base + p] = val;
				if (val < min) min = val;
				if (val > max) max = val;
			}
		}
		sumC += dec.defaultCenter;
		sumW += dec.defaultWidth;
	}
	if (!Number.isFinite(min)) {
		min = 0;
		max = 0;
	}

	return {
		nx,
		ny,
		nz,
		data,
		invAffine,
		frameOfReferenceUID: forUID,
		min,
		max,
		defaultCenter: sumC / nz,
		defaultWidth: sumW / nz,
	};
}

/** Trilinear sample at continuous voxel coords; NaN if outside the volume. */
function sampleVoxel(vol: Volume, fx: number, fy: number, fz: number): number {
	const { nx, ny, nz, data } = vol;
	if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) {
		return NaN;
	}
	const x0 = Math.floor(fx),
		y0 = Math.floor(fy),
		z0 = Math.floor(fz);
	const x1 = Math.min(x0 + 1, nx - 1),
		y1 = Math.min(y0 + 1, ny - 1),
		z1 = Math.min(z0 + 1, nz - 1);
	const dx = fx - x0,
		dy = fy - y0,
		dz = fz - z0;
	const nxy = nx * ny;
	const idx = (x: number, y: number, z: number) => z * nxy + y * nx + x;

	const c000 = data[idx(x0, y0, z0)];
	const c100 = data[idx(x1, y0, z0)];
	const c010 = data[idx(x0, y1, z0)];
	const c110 = data[idx(x1, y1, z0)];
	const c001 = data[idx(x0, y0, z1)];
	const c101 = data[idx(x1, y0, z1)];
	const c011 = data[idx(x0, y1, z1)];
	const c111 = data[idx(x1, y1, z1)];

	const c00 = c000 * (1 - dx) + c100 * dx;
	const c10 = c010 * (1 - dx) + c110 * dx;
	const c01 = c001 * (1 - dx) + c101 * dx;
	const c11 = c011 * (1 - dx) + c111 * dx;
	const c0 = c00 * (1 - dy) + c10 * dy;
	const c1 = c01 * (1 - dy) + c11 * dy;
	return c0 * (1 - dz) + c1 * dz;
}

export interface PlaneGeometry {
	ipp: number[]; // ImagePositionPatient of the primary slice
	xr: number[]; // row direction cosines
	xc: number[]; // column direction cosines
	psRow: number; // PixelSpacing[0]
	psCol: number; // PixelSpacing[1]
	cols: number;
	rows: number;
}

export interface ResampledPlane {
	values: Float32Array; // overlay modality value per primary pixel
	mask: Uint8Array; // 1 where the overlay covers this pixel, else 0
}

/**
 * Resample `vol` onto the primary slice plane. `mPrimaryToOverlay` maps points
 * from the primary Frame of Reference into the overlay's Frame of Reference.
 */
export function resamplePlane(
	geom: PlaneGeometry,
	vol: Volume,
	mPrimaryToOverlay: Mat4
): ResampledPlane {
	const { ipp, xr, xc, psRow, psCol, cols, rows } = geom;
	const values = new Float32Array(cols * rows);
	const mask = new Uint8Array(cols * rows);
	const inv = vol.invAffine;
	const M = mPrimaryToOverlay;

	for (let i = 0; i < rows; i++) {
		// Row origin in primary patient space.
		const rx = ipp[0] + i * psRow * xc[0];
		const ry = ipp[1] + i * psRow * xc[1];
		const rz = ipp[2] + i * psRow * xc[2];
		for (let j = 0; j < cols; j++) {
			const px = rx + j * psCol * xr[0];
			const py = ry + j * psCol * xr[1];
			const pz = rz + j * psCol * xr[2];
			// primary FoR -> overlay FoR
			const ox = M[0] * px + M[1] * py + M[2] * pz + M[3];
			const oy = M[4] * px + M[5] * py + M[6] * pz + M[7];
			const oz = M[8] * px + M[9] * py + M[10] * pz + M[11];
			// overlay patient -> overlay voxel
			const vx = inv[0] * ox + inv[1] * oy + inv[2] * oz + inv[3];
			const vy = inv[4] * ox + inv[5] * oy + inv[6] * oz + inv[7];
			const vz = inv[8] * ox + inv[9] * oy + inv[10] * oz + inv[11];
			const v = sampleVoxel(vol, vx, vy, vz);
			const o = i * cols + j;
			if (Number.isNaN(v)) {
				mask[o] = 0;
			} else {
				values[o] = v;
				mask[o] = 1;
			}
		}
	}
	return { values, mask };
}

// Re-export for the renderer's convenience.
export { transformPoint };
