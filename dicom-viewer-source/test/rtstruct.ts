// test/rtstruct.ts — validates RTSTRUCT parsing against the real file.
import * as fs from "fs";
import { parseDicom } from "dicom-parser";
import {
	parseRTStruct,
	isRTStructSOP,
	categoryOf,
	CATEGORY_ORDER,
} from "../src/rtstruct";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
	if (!cond) failures++;
}

const ds = parseDicom(
	new Uint8Array(
		fs.readFileSync(
			"/mnt/user-data/uploads/RS1_2_752_243_1_1_20260622133113043_1546_54835.dcm"
		)
	)
);

check("recognised as RTSTRUCT SOP", isRTStructSOP(ds.string("x00080016")));

const rt = parseRTStruct(ds);
check("frame of reference parsed", rt.frameOfReferenceUID?.endsWith("50134") ?? false,
	rt.frameOfReferenceUID ?? "(none)");
check("54 ROIs parsed", rt.rois.length === 54, String(rt.rois.length));

const byName = (n: string) => rt.rois.find((r) => r.name === n);
const ext = byName("External");
check("External ROI present", !!ext);
check("External has many contours", (ext?.contours.length ?? 0) > 100, String(ext?.contours.length));
check("External colour parsed", JSON.stringify(ext?.color) === "[255,255,255]", JSON.stringify(ext?.color));
check("contour points are triples", (ext?.contours[0].points.length ?? 0) % 3 === 0,
	String(ext?.contours[0].points.length));

const gtv = byName("GTVp1");
check("GTVp1 categorised as Target", gtv?.category === "Target", gtv?.interpretedType);
const ptv = byName("PTVp_6000");
check("PTVp_6000 categorised as Target", ptv?.category === "Target", ptv?.interpretedType);
check("Brainstem categorised as Organ", byName("Brainstem")?.category === "Organ",
	byName("Brainstem")?.interpretedType);
check("External categorised as External", ext?.category === "External", ext?.interpretedType);

// Category breakdown
const counts: Record<string, number> = {};
for (const r of rt.rois) counts[r.category] = (counts[r.category] ?? 0) + 1;
console.log("  category counts:", CATEGORY_ORDER.map((c) => `${c}:${counts[c] ?? 0}`).join("  "));
check("has Target and Organ categories", (counts["Target"] ?? 0) > 0 && (counts["Organ"] ?? 0) > 0);

// categoryOf unit checks
check("categoryOf PTV→Target", categoryOf("PTV") === "Target");
check("categoryOf ORGAN→Organ", categoryOf("ORGAN") === "Organ");
check("categoryOf ''→Other", categoryOf("") === "Other");
check("categoryOf DOSE_REGION→Other", categoryOf("DOSE_REGION") === "Other");

console.log(failures === 0 ? "\nRTSTRUCT TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
