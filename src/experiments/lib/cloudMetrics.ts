import { applyRigid2D, bestFitRigid2D, type Pt } from "./metrics.ts";
import type { FusedRecord } from "../../logic/CloudBackend.ts";

/**
 * For each nodeId, keep only the latest fused record.
 */
export function latestByNode(records: FusedRecord[]) {
	const map = new Map<number, FusedRecord>();
	for (const r of records) {
		const prev = map.get(r.nodeId);
		if (!prev || r.timestamp >= prev.timestamp) map.set(r.nodeId, r);
	}
	return map;
}

/**
 * Computes RMSE between cloud fused positions and known ground truth.
 *
 * Returns both error and coverage (how many nodes had a fused record).
 * IMPORTANT: This assumes the cloud graph is already in the global frame!
 */
export function cloudRmse(latest: Map<number, FusedRecord>, truth: Map<number, { x: number; y: number }>) {
	let sumSq = 0;
	let count = 0;
	for (const [id, t] of truth.entries()) {
		const r = latest.get(id);
		if (!r) continue;
		// Skip nodes that are explicitly uncertain/isolated (e.g. panic state)
		if (r.status === "UNCERTAIN") continue;

		const dx = r.position.x - t.x;
		const dy = r.position.y - t.y;
		sumSq += dx * dx + dy * dy;
		count += 1;
	}
	return { rmse: count > 0 ? Math.sqrt(sumSq / count) : Number.NaN, coverage: count };
}

/**
 * Computes Aligned RMSE (RMSD) for cloud positions.
 *
 * This performs a rigid alignment (Best Fit) before scoring, which is critical
 * if the cloud graph is floating (anchor-free).
 */
export function cloudRmseAligned(latest: Map<number, FusedRecord>, truth: Map<number, { x: number; y: number }>) {
	const estPoints: Pt[] = [];
	const truePoints: Pt[] = [];

	for (const [id, t] of truth.entries()) {
		const r = latest.get(id);
		if (!r) continue;
		// Skip nodes that are explicitly uncertain/isolated (e.g. panic state)
		if (r.status === "UNCERTAIN") continue;

		estPoints.push({ x: r.position.x, y: r.position.y });
		truePoints.push({ x: t.x, y: t.y });
	}

	if (estPoints.length < 2) return { rmse: Number.NaN, coverage: estPoints.length };

	const tf = bestFitRigid2D(truePoints, estPoints);
	if (!tf) return { rmse: Number.NaN, coverage: estPoints.length };

	let sumSq = 0;
	for (let i = 0; i < estPoints.length; i++) {
		const aligned = applyRigid2D(estPoints[i], tf);
		const dx = aligned.x - truePoints[i].x;
		const dy = aligned.y - truePoints[i].y;
		sumSq += dx * dx + dy * dy;
	}

	return { rmse: Math.sqrt(sumSq / estPoints.length), coverage: estPoints.length };
}
