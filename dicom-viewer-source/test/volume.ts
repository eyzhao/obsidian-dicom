// test/volume.ts — synthetic volume where value encodes position, so resampling
// correctness can be checked exactly.
import { buildVolume, resamplePlane, Volume } from "../src/volume";
import { identity4 } from "../src/registration";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}
const approx = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

// 4x4x3 axial volume. Voxel (j,i,k) sits at patient [j, i, 2k]. Value = 100k+10i+j.
const NX = 4, NY = 4, NZ = 3;
const mkSlice = (k: number) =>
	({
		position: [0, 0, 2 * k],
		orientation: [1, 0, 0, 0, 1, 0],
		dataSet: {} as any,
		frameIndex: 0,
		instanceNumber: k,
		sortPos: 2 * k,
		sourceName: `s${k}`,
	} as any);
const slices = [mkSlice(0), mkSlice(1), mkSlice(2)];
const decode = (s: any) => {
	const k = s.position[2] / 2;
	const values = new Float32Array(NX * NY);
	for (let i = 0; i < NY; i++)
		for (let j = 0; j < NX; j++) values[i * NX + j] = 100 * k + 10 * i + j;
	return {
		width: NX, height: NY, isColor: false, values,
		min: 0, max: 999, monochrome1: false,
		defaultCenter: 128, defaultWidth: 256, pixelSpacing: [1, 1] as [number, number],
	};
};

const vol = buildVolume(slices, decode, "MR_FOR") as Volume;
check("volume built", !!vol);
check("dims 4x4x3", vol.nx === 4 && vol.ny === 4 && vol.nz === 3);
check("frame of reference stored", vol.frameOfReferenceUID === "MR_FOR");

const plane = { ipp: [0, 0, 2], xr: [1, 0, 0], xc: [0, 1, 0], psRow: 1, psCol: 1, cols: 4, rows: 4 };

// 1) identity registration, plane == slice k=1 => values = 100 + 10i + j
{
	const { values, mask } = resamplePlane(plane, vol, identity4());
	let ok = true;
	for (let i = 0; i < 4; i++)
		for (let j = 0; j < 4; j++) {
			if (!approx(values[i * 4 + j], 100 + 10 * i + j) || mask[i * 4 + j] !== 1) ok = false;
		}
	check("identity resample recovers slice k=1", ok,
		`corner ${values[0]} center ${values[5]}`);
}

// 2) translation +2mm in z (primary->overlay) => sample slice k=2 => 200+10i+j
{
	const M = identity4(); M[11] = 2;
	const { values } = resamplePlane(plane, vol, M);
	check("z+2 translation samples slice k=2", approx(values[0], 200) && approx(values[5], 211),
		`v00=${values[0]} v11=${values[5]} (expect 200, 211)`);
}

// 3) half-voxel z shift => trilinear average of k=1 and k=2 => 150+10i+j
{
	const M = identity4(); M[11] = 1; // +1mm = half a 2mm slice
	const { values } = resamplePlane(plane, vol, M);
	check("z+1 (half slice) trilinear averages k=1,2", approx(values[5], 161),
		`expected 161 got ${values[5]}`);
}

// 4) out-of-volume => mask 0
{
	const M = identity4(); M[11] = 1000;
	const { mask } = resamplePlane(plane, vol, M);
	check("far translation falls outside (mask 0)", mask[0] === 0 && mask[5] === 0);
}

// 5) in-plane half-pixel shift in x => average of neighbours j and j+1
{
	const M = identity4(); M[3] = 0.5; // +0.5mm in x = half a column
	const { values } = resamplePlane(plane, vol, M);
	// at (i=1,j=1): average of (j=1 ->111) and (j=2 ->112) = 111.5
	check("x+0.5 in-plane trilinear", approx(values[1 * 4 + 1], 111.5),
		`got ${values[1 * 4 + 1]}`);
}

console.log(failures === 0 ? "\nVOLUME TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
