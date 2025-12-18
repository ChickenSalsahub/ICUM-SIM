import { describe, expect, it } from "vitest";
import { computeCloudStructureStatsMeters, type CloudPositionRecord, type Pt2 } from "../CloudTopologyMetrics.ts";

function truthMap(pts: Array<{ id: number; x: number; y: number }>) {
	const m = new Map<number, Pt2>();
	for (const p of pts) m.set(p.id, { x: p.x, y: p.y });
	return m;
}

describe("computeCloudStructureStatsMeters", () => {
	it("computes absolute MAE/RMSE over matched records", () => {
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 0, y: 0 },
		]);
		const records: CloudPositionRecord[] = [
			{ nodeId: 1, position: { x: 3, y: 0 } }, // err=3
			{ nodeId: 2, position: { x: 0, y: 4 } }, // err=4
		];
		const stats = computeCloudStructureStatsMeters({ records, truthById });
		expect(stats).not.toBeNull();
		expect(stats!.abs.mae).toBeCloseTo((3 + 4) / 2, 12);
		expect(stats!.abs.rmse).toBeCloseTo(Math.sqrt((9 + 16) / 2), 12);
		expect(stats!.n).toBe(2);
		expect(stats!.pairs).toBe(1);
	});

	it("aligned error is ~0 for a pure rigid transform (rotation+translation)", () => {
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 2, y: 0 },
			{ id: 3, x: 0, y: 1 },
		]);
		const theta = Math.PI / 3;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		const tx = 7;
		const ty = -4;
		const rot = (p: Pt2) => ({ x: c * p.x - s * p.y + tx, y: s * p.x + c * p.y + ty });

		const records: CloudPositionRecord[] = [
			{ nodeId: 1, position: rot({ x: 0, y: 0 }) },
			{ nodeId: 2, position: rot({ x: 2, y: 0 }) },
			{ nodeId: 3, position: rot({ x: 0, y: 1 }) },
		];
		const stats = computeCloudStructureStatsMeters({ records, truthById })!;
		expect(stats.abs.rmse).toBeGreaterThan(0.1);
		expect(stats.aligned.rmse).toBeCloseTo(0, 8);
		expect(stats.aligned.mae).toBeCloseTo(0, 8);
	});

	it("alignment allows reflection when it gives lower SSE", () => {
		// Truth triangle (non-colinear). Estimates are mirrored on Y and translated.
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 1, y: 0 },
			{ id: 3, x: 0, y: 2 },
		]);
		const tx = 10;
		const ty = -3;
		const mirrorY = (p: Pt2) => ({ x: p.x + tx, y: -p.y + ty });

		const records: CloudPositionRecord[] = [
			{ nodeId: 1, position: mirrorY({ x: 0, y: 0 }) },
			{ nodeId: 2, position: mirrorY({ x: 1, y: 0 }) },
			{ nodeId: 3, position: mirrorY({ x: 0, y: 2 }) },
		];

		const stats = computeCloudStructureStatsMeters({ records, truthById })!;
		expect(stats.abs.rmse).toBeGreaterThan(0.1);
		expect(stats.aligned.rmse).toBeCloseTo(0, 8);
	});

	it("aligned error can be computed per disconnected component", () => {
		// Two disconnected 2-node clusters with different rigid frames.
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 1, y: 0 },
			{ id: 3, x: 10, y: 0 },
			{ id: 4, x: 11, y: 0 },
		]);

		// Cluster A is rotated +90deg and translated.
		const txA = 10;
		const tyA = -5;
		const rot90 = (p: Pt2) => ({ x: -p.y + txA, y: p.x + tyA });

		// Cluster B is only translated.
		const txB = -30;
		const tyB = 3;
		const transB = (p: Pt2) => ({ x: p.x + txB, y: p.y + tyB });

		const records: CloudPositionRecord[] = [
			{ nodeId: 1, position: rot90({ x: 0, y: 0 }) },
			{ nodeId: 2, position: rot90({ x: 1, y: 0 }) },
			{ nodeId: 3, position: transB({ x: 10, y: 0 }) },
			{ nodeId: 4, position: transB({ x: 11, y: 0 }) },
		];

		// Without component info, a single global transform cannot align both clusters.
		const globalStats = computeCloudStructureStatsMeters({ records, truthById })!;
		expect(globalStats.abs.rmse).toBeGreaterThan(0.1);
		expect(globalStats.aligned.rmse).toBeGreaterThan(0.01);

		// With edges indicating two components, each aligns independently.
		const edges: Array<[number, number]> = [
			[1, 2],
			[3, 4],
		];
		const compStats = computeCloudStructureStatsMeters({ records, truthById, edges })!;
		expect(compStats.aligned.rmse).toBeCloseTo(0, 8);
		expect(compStats.aligned.mae).toBeCloseTo(0, 8);
	});

	it("pairwise distance MAE is invariant under rigid transforms", () => {
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 3, y: 0 },
			{ id: 3, x: 0, y: 4 },
			{ id: 4, x: 2, y: 2 },
		]);

		const theta = Math.PI / 4;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		const tx = 3.3;
		const ty = -2.2;
		const tf = (p: Pt2) => ({ x: c * p.x - s * p.y + tx, y: s * p.x + c * p.y + ty });

		const records: CloudPositionRecord[] = [
			{ nodeId: 1, position: tf({ x: 0, y: 0 }) },
			{ nodeId: 2, position: tf({ x: 3, y: 0 }) },
			{ nodeId: 3, position: tf({ x: 0, y: 4 }) },
			{ nodeId: 4, position: tf({ x: 2, y: 2 }) },
		];
		const stats = computeCloudStructureStatsMeters({ records, truthById })!;
		expect(stats.pairwiseDistMae).toBeCloseTo(0, 10);
		expect(stats.pairs).toBe((stats.n * (stats.n - 1)) / 2);
	});

	it("filters records without truth or non-finite coordinates", () => {
		const truthById = truthMap([
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 1, y: 0 },
		]);
		const records: CloudPositionRecord[] = [
			{ nodeId: 999, position: { x: 0, y: 0 } }, // no truth
			{ nodeId: 1, position: { x: Number.NaN, y: 0 } }, // non-finite
			{ nodeId: 2, position: { x: 1, y: 0 } }, // valid
		];
		const stats = computeCloudStructureStatsMeters({ records, truthById })!;
		expect(stats.n).toBe(1);
		expect(stats.pairs).toBe(0);
		expect(stats.pairwiseDistMae).toBe(0);
	});

	it("returns null when nothing matches", () => {
		const truthById = truthMap([{ id: 1, x: 0, y: 0 }]);
		const records: CloudPositionRecord[] = [{ nodeId: 2, position: { x: 1, y: 1 } }];
		expect(computeCloudStructureStatsMeters({ records, truthById })).toBeNull();
	});
});
