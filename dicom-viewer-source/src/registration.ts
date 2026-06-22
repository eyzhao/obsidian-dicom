/*
 * registration.ts — DICOM Spatial Registration (REG) parsing and the 4×4 affine
 * math needed to map points between co-registered Frames of Reference.
 *
 * A Spatial Registration object (SOP 1.2.840.10008.5.1.4.1.1.66.1) contains a
 * RegistrationSequence; each item has a FrameOfReferenceUID (0020,0052) and a
 * FrameOfReferenceTransformationMatrix (3006,00C6) that maps coordinates from
 * THAT frame of reference into a common "registered" space. The item whose
 * matrix is identity defines which series is the fixed reference.
 *
 * Deformable Spatial Registration (…66.3) is detected and reported as
 * unsupported (it needs a deformation grid, not a single matrix).
 */

import { DataSet, Element } from "dicom-parser";

export type Mat4 = number[]; // length 16, row-major

const TAG = {
	sopClassUID: "x00080016",
	frameOfReferenceUID: "x00200052",
	registrationSequence: "x00700308",
	matrixRegistrationSequence: "x00700309",
	matrixSequence: "x0070030a",
	matrixType: "x0070030c",
	transformationMatrix: "x300600c6",
	referencedImageSequence: "x00081140",
};

const REG_RIGID_SOP = "1.2.840.10008.5.1.4.1.1.66.1";
const REG_DEFORMABLE_SOP = "1.2.840.10008.5.1.4.1.1.66.3";

export function isRegistrationSOP(sop: string | undefined): boolean {
	return sop === REG_RIGID_SOP || sop === REG_DEFORMABLE_SOP;
}

export function identity4(): Mat4 {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Row-major 4×4 multiply: returns a*b. */
export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
	const out = new Array(16).fill(0);
	for (let r = 0; r < 4; r++) {
		for (let c = 0; c < 4; c++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
			out[r * 4 + c] = s;
		}
	}
	return out;
}

/** Transform a 3-point (implicit w=1) by a row-major 4×4. */
export function transformPoint(m: Mat4, p: number[]): number[] {
	const x = p[0],
		y = p[1],
		z = p[2];
	return [
		m[0] * x + m[1] * y + m[2] * z + m[3],
		m[4] * x + m[5] * y + m[6] * z + m[7],
		m[8] * x + m[9] * y + m[10] * z + m[11],
	];
}

/** General 4×4 inverse (cofactor method). Returns identity if singular. */
export function mat4Inverse(m: Mat4): Mat4 {
	const inv = new Array(16);
	inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
	inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
	inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
	inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
	inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
	inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
	inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
	inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
	inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
	inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
	inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
	inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
	inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
	inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
	inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
	inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

	let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
	if (!det) return identity4();
	det = 1.0 / det;
	return inv.map((v) => v * det);
}

export interface RegistrationEntry {
	frameOfReferenceUID: string;
	matrix: Mat4; // maps this FoR -> registered space
	type: string; // RIGID / AFFINE / RIGID_SCALE
}

export interface ParsedRegistration {
	sopClassUID: string | undefined;
	isDeformable: boolean;
	entries: RegistrationEntry[];
}

function readMatrix(d: DataSet): Mat4 | null {
	const raw = d.string(TAG.transformationMatrix);
	if (!raw) return null;
	const vals = raw
		.split("\\")
		.map((x) => parseFloat(x))
		.filter((x) => !Number.isNaN(x));
	return vals.length === 16 ? vals : null;
}

/** Compose all matrices in a registration item's MatrixSequence(s), in order. */
function composeItemMatrix(itemDs: DataSet): Mat4 {
	let m = identity4();
	const mrs = itemDs.elements[TAG.matrixRegistrationSequence];
	mrs?.items?.forEach((mr: Element) => {
		const ms = mr.dataSet?.elements[TAG.matrixSequence];
		ms?.items?.forEach((mat: Element) => {
			const mm = mat.dataSet ? readMatrix(mat.dataSet) : null;
			if (mm) m = mat4Mul(mm, m); // later matrices pre-multiply (applied after)
		});
	});
	return m;
}

export function parseRegistration(ds: DataSet): ParsedRegistration {
	const sop = ds.string(TAG.sopClassUID);
	const isDeformable = sop === REG_DEFORMABLE_SOP;
	const entries: RegistrationEntry[] = [];

	const regSeq = ds.elements[TAG.registrationSequence];
	regSeq?.items?.forEach((item: Element) => {
		const d = item.dataSet;
		if (!d) return;
		const forUID = d.string(TAG.frameOfReferenceUID);
		if (!forUID) return;
		const matrix = composeItemMatrix(d);
		const ms = d.elements[TAG.matrixRegistrationSequence]?.items?.[0]
			?.dataSet?.elements[TAG.matrixSequence]?.items?.[0]?.dataSet;
		const type = ms?.string(TAG.matrixType) ?? "RIGID";
		entries.push({ frameOfReferenceUID: forUID, matrix, type });
	});

	return { sopClassUID: sop, isDeformable, entries };
}

/**
 * Collects registration matrices across one or more REG files into a single
 * lookup: FrameOfReferenceUID -> matrix mapping that FoR into registered space.
 */
export class RegistrationRegistry {
	private forToRegistered = new Map<string, Mat4>();
	deformableSeen = false;

	add(reg: ParsedRegistration) {
		if (reg.isDeformable) {
			this.deformableSeen = true;
			return; // matrices not meaningful for deformable
		}
		for (const e of reg.entries) {
			// Prefer an identity (reference) mapping if one is already present.
			if (!this.forToRegistered.has(e.frameOfReferenceUID)) {
				this.forToRegistered.set(e.frameOfReferenceUID, e.matrix);
			}
		}
	}

	has(forUID: string | undefined): boolean {
		return !!forUID && this.forToRegistered.has(forUID);
	}

	get size(): number {
		return this.forToRegistered.size;
	}

	/**
	 * Matrix mapping points from `fromFoR` patient space into `toFoR` patient
	 * space. Returns identity if the frames are the same, or null if either
	 * frame is unknown to the registry.
	 */
	transform(
		fromFoR: string | undefined,
		toFoR: string | undefined
	): Mat4 | null {
		if (!fromFoR || !toFoR) return null;
		if (fromFoR === toFoR) return identity4();
		const mFrom = this.forToRegistered.get(fromFoR);
		const mTo = this.forToRegistered.get(toFoR);
		if (!mFrom || !mTo) return null;
		// P_to = inv(M_to) * M_from * P_from
		return mat4Mul(mat4Inverse(mTo), mFrom);
	}
}
