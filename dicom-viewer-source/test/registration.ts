// test/registration.ts — validates REG parsing and FoR-to-FoR transforms.
import * as fs from "fs";
import { parseDicom } from "dicom-parser";
import {
	parseRegistration,
	RegistrationRegistry,
	transformPoint,
	mat4Mul,
	mat4Inverse,
	identity4,
} from "../src/registration";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}
const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

const ds = parseDicom(
	new Uint8Array(
		fs.readFileSync(
			"/mnt/user-data/uploads/REG1_2_752_243_1_1_20260622133113670_1550_82474.dcm"
		)
	)
);

const reg = parseRegistration(ds);
check("parsed as rigid (not deformable)", !reg.isDeformable);
check("two registration entries", reg.entries.length === 2, String(reg.entries.length));

// Identify the identity (fixed) entry and the moving entry.
const isIdentity = (m: number[]) =>
	identity4().every((v, i) => approx(v, m[i]));
const fixed = reg.entries.find((e) => isIdentity(e.matrix));
const moving = reg.entries.find((e) => !isIdentity(e.matrix));
check("one entry is identity (fixed reference)", !!fixed);
check("one entry is a real transform (moving)", !!moving);

// Known moving translation from the file.
if (moving) {
	check("moving translation x ≈ 6.581", approx(moving.matrix[3], 6.58114, 1e-3), String(moving.matrix[3]));
	check("moving translation y ≈ -36.41", approx(moving.matrix[7], -36.41024, 1e-3), String(moving.matrix[7]));
	check("moving translation z ≈ -372.38", approx(moving.matrix[11], -372.3841, 1e-3), String(moving.matrix[11]));
	// Rigid => rotation submatrix is orthonormal => det ≈ 1
	const m = moving.matrix;
	const det = m[0]*(m[5]*m[10]-m[6]*m[9]) - m[1]*(m[4]*m[10]-m[6]*m[8]) + m[2]*(m[4]*m[9]-m[5]*m[8]);
	check("rotation determinant ≈ 1", approx(det, 1, 1e-3), det.toFixed(5));
}

// Registry transforms.
const registry = new RegistrationRegistry();
registry.add(reg);
const ctFoR = fixed!.frameOfReferenceUID;
const mrFoR = moving!.frameOfReferenceUID;

check("registry knows both frames", registry.has(ctFoR) && registry.has(mrFoR));
check("same-frame transform is identity", isIdentity(registry.transform(ctFoR, ctFoR)!));

// A point in MR space, mapped to CT and back, returns to itself.
const pMR = [12.3, -45.6, 78.9];
const mMRtoCT = registry.transform(mrFoR, ctFoR)!;
const mCTtoMR = registry.transform(ctFoR, mrFoR)!;
const pCT = transformPoint(mMRtoCT, pMR);
const pBack = transformPoint(mCTtoMR, pCT);
check("round-trip MR→CT→MR recovers point",
	approx(pMR[0], pBack[0]) && approx(pMR[1], pBack[1]) && approx(pMR[2], pBack[2]),
	`[${pBack.map((x) => x.toFixed(3))}]`);

// Since CT is the fixed (identity) frame, MR→CT must equal the moving matrix.
check("MR→CT equals the moving matrix (CT is registered space)",
	moving!.matrix.every((v, i) => approx(v, mMRtoCT[i])));

// inverse(M)*M ≈ I sanity
const I = mat4Mul(mat4Inverse(moving!.matrix), moving!.matrix);
check("inv(M)*M ≈ identity", isIdentity(I));

console.log(failures === 0 ? "\nREGISTRATION TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
