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
 */
export function cloudRmse(latest: Map<number, FusedRecord>, truth: Map<number, { x: number; y: number }>) {
	let sumSq = 0;
	let count = 0;
	for (const [id, t] of truth.entries()) {
		const r = latest.get(id);
		if (!r) continue;
		const dx = r.position.x - t.x;
		const dy = r.position.y - t.y;
		sumSq += dx * dx + dy * dy;
		count += 1;
	}
	return { rmse: count > 0 ? Math.sqrt(sumSq / count) : Number.NaN, coverage: count };
}
