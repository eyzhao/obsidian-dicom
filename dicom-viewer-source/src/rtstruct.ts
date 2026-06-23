/*
 * rtstruct.ts — DICOM RT Structure Set parsing.
 *
 * An RTSTRUCT (SOP 1.2.840.10008.5.1.4.1.1.481.3) defines regions of interest as
 * stacks of planar contours in patient coordinates of a referenced Frame of
 * Reference. We pair each ROI with its display colour and its RT interpreted
 * type (GTV/CTV/PTV/ORGAN/EXTERNAL/…) so the UI can group them.
 */

import { DataSet, Element } from "dicom-parser";

const TAG = {
	sopClassUID: "x00080016",
	structureSetLabel: "x30060002",
	referencedFrameOfReferenceSeq: "x30060010",
	frameOfReferenceUID: "x00200052",
	structureSetROISeq: "x30060020",
	roiNumber: "x30060022",
	referencedFrameOfReferenceUID: "x30060024",
	roiName: "x30060026",
	rtRoiObservationsSeq: "x30060080",
	referencedROINumber: "x30060084",
	rtRoiInterpretedType: "x300600a4",
	roiContourSeq: "x30060039",
	roiDisplayColor: "x3006002a",
	contourSeq: "x30060040",
	contourGeometricType: "x30060042",
	numberOfContourPoints: "x30060046",
	contourData: "x30060050",
};

const RTSTRUCT_SOP = "1.2.840.10008.5.1.4.1.1.481.3";

export function isRTStructSOP(sop: string | undefined): boolean {
	return sop === RTSTRUCT_SOP;
}

export type StructureCategory =
	| "Target"
	| "Organ"
	| "External"
	| "Avoidance"
	| "Other";

export const CATEGORY_ORDER: StructureCategory[] = [
	"Target",
	"Organ",
	"External",
	"Avoidance",
	"Other",
];

export function categoryOf(interpretedType: string): StructureCategory {
	const t = (interpretedType || "").toUpperCase();
	if (/\b(PTV|CTV|GTV|ITV|TARGET|TUMOR|TUMOUR)\b/.test(t) || /PTV|CTV|GTV/.test(t))
		return "Target";
	if (t === "ORGAN" || t === "OAR") return "Organ";
	if (t === "EXTERNAL" || t === "BODY") return "External";
	if (t === "AVOIDANCE") return "Avoidance";
	return "Other";
}

export interface Contour {
	points: Float32Array; // x,y,z triples in the RTSTRUCT frame of reference
	geometricType: string;
}

export interface ROI {
	number: number;
	name: string;
	color: [number, number, number];
	interpretedType: string;
	category: StructureCategory;
	contours: Contour[];
}

export interface RTStruct {
	label: string;
	frameOfReferenceUID?: string;
	rois: ROI[];
}

function parseColor(raw: string | undefined): [number, number, number] {
	if (!raw) return [255, 255, 0];
	const v = raw.split("\\").map((x) => parseInt(x, 10));
	if (v.length >= 3 && v.every((n) => !Number.isNaN(n)))
		return [v[0], v[1], v[2]];
	return [255, 255, 0];
}

function parseContourData(raw: string | undefined): Float32Array {
	if (!raw) return new Float32Array(0);
	const parts = raw.split("\\");
	const out = new Float32Array(parts.length);
	for (let i = 0; i < parts.length; i++) out[i] = parseFloat(parts[i]);
	return out;
}

export function parseRTStruct(ds: DataSet): RTStruct {
	const label = ds.string(TAG.structureSetLabel) ?? "RT Struct";

	// Frame of reference the contours are defined in.
	let forUID: string | undefined;
	const rforSeq = ds.elements[TAG.referencedFrameOfReferenceSeq];
	if (rforSeq?.items?.length) {
		forUID = rforSeq.items[0].dataSet?.string(TAG.frameOfReferenceUID);
	}

	// ROI metadata (name + per-ROI FoR) keyed by ROI number.
	const nameByNumber = new Map<number, string>();
	const forByNumber = new Map<number, string>();
	ds.elements[TAG.structureSetROISeq]?.items?.forEach((it: Element) => {
		const d = it.dataSet;
		if (!d) return;
		const num = parseInt(d.string(TAG.roiNumber) ?? "-1", 10);
		if (num < 0) return;
		nameByNumber.set(num, d.string(TAG.roiName) ?? `ROI ${num}`);
		const f = d.string(TAG.referencedFrameOfReferenceUID);
		if (f) forByNumber.set(num, f);
	});
	if (!forUID && forByNumber.size) {
		forUID = forByNumber.values().next().value;
	}

	// Interpreted type keyed by ROI number.
	const typeByNumber = new Map<number, string>();
	ds.elements[TAG.rtRoiObservationsSeq]?.items?.forEach((it: Element) => {
		const d = it.dataSet;
		if (!d) return;
		const num = parseInt(d.string(TAG.referencedROINumber) ?? "-1", 10);
		if (num >= 0)
			typeByNumber.set(num, d.string(TAG.rtRoiInterpretedType) ?? "");
	});

	// Contours + colour keyed by ROI number.
	const rois: ROI[] = [];
	ds.elements[TAG.roiContourSeq]?.items?.forEach((it: Element) => {
		const d = it.dataSet;
		if (!d) return;
		const num = parseInt(d.string(TAG.referencedROINumber) ?? "-1", 10);
		if (num < 0) return;
		const color = parseColor(d.string(TAG.roiDisplayColor));
		const contours: Contour[] = [];
		d.elements[TAG.contourSeq]?.items?.forEach((c: Element) => {
			const cd = c.dataSet;
			if (!cd) return;
			const points = parseContourData(cd.string(TAG.contourData));
			if (points.length >= 3) {
				contours.push({
					points,
					geometricType:
						cd.string(TAG.contourGeometricType) ?? "CLOSED_PLANAR",
				});
			}
		});
		const interpretedType = typeByNumber.get(num) ?? "";
		rois.push({
			number: num,
			name: nameByNumber.get(num) ?? `ROI ${num}`,
			color,
			interpretedType,
			category: categoryOf(interpretedType),
			contours,
		});
	});

	// Stable order: by ROI number.
	rois.sort((a, b) => a.number - b.number);
	return { label, frameOfReferenceUID: forUID, rois };
}
