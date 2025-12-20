import { describe, expect, it } from "vitest";
import type { FirmwareSnapshot, NeighborObservation } from "../../firmware/types.ts";
import type { RunnerSnapshot } from "../lib/types.ts";
import {
	ale,
	aleAlignedRigid,
	mae,
	measurementAngleResidualMae,
	measurementRangeResidualMae,
	pairwiseDistanceMae,
	rmse,
	rmseAlignedRigid,
} from "../lib/metrics.ts";

type RunnerNode = RunnerSnapshot["nodes"][number];

type PartialFirmware = Pick<FirmwareSnapshot, "estPosition" | "neighbors">;

function makeNode(args: { id: number; trueX: number; trueY: number; estX: number; estY: number }): RunnerNode {
	const firmware: PartialFirmware = {
		estPosition: { x: args.estX, y: args.estY },
		neighbors: [],
	};

	return {
		id: args.id,
		trueX: args.trueX,
		trueY: args.trueY,
		batteryV: 3.7,
		firmware: firmware as FirmwareSnapshot,
		txCount: 0,
	};
}

function mulberry32(seed: number) {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let x = t;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

describe("experiments metrics", () => {
	it("rmse computes root-mean-squared Euclidean position error", () => {
		// Two nodes, with errors 3 and 4.
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: 3, estY: 0 }), // err = 3
			makeNode({ id: 2, trueX: 0, trueY: 0, estX: 0, estY: 4 }), // err = 4
		];
		// RMSE = sqrt((3^2 + 4^2)/2)
		expect(rmse(nodes)).toBeCloseTo(Math.sqrt((9 + 16) / 2), 10);
	});

	it("mae is mean Euclidean position error (and ale matches mae)", () => {
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: 3, estY: 0 }), // err = 3
			makeNode({ id: 2, trueX: 0, trueY: 0, estX: 0, estY: 4 }), // err = 4
		];
		expect(mae(nodes)).toBeCloseTo((3 + 4) / 2, 10);
		expect(ale(nodes)).toBeCloseTo(mae(nodes), 12);
	});

	it("aleAlignedRigid is invariant to global rotation + translation", () => {
		// Truth points (non-colinear):
		// (0,0), (1,0), (0,1)
		// Estimated points are rotated +90deg and translated by (10,-5):
		// R(x,y) = (-y, x)
		// est = R(truth) + t
		const tx = 10;
		const ty = -5;
		const rot = (x: number, y: number) => ({ x: -y, y: x });

		const truth: Array<{ x: number; y: number }> = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 0, y: 1 },
		];

		const nodes: RunnerNode[] = truth.map((p, idx) => {
			const r = rot(p.x, p.y);
			return makeNode({
				id: idx + 1,
				trueX: p.x,
				trueY: p.y,
				estX: r.x + tx,
				estY: r.y + ty,
			});
		});

		// Raw ALE is not zero (frame mismatch), but aligned ALE should be ~0.
		expect(ale(nodes)).toBeGreaterThan(0.1);
		expect(aleAlignedRigid(nodes)).toBeCloseTo(0, 8);
	});

	it("aleAlignedRigid can resolve a reflected solution (mirror) when needed", () => {
		const truth: Array<{ x: number; y: number }> = [
			{ x: 0, y: 0 },
			{ x: 2, y: 0 },
			{ x: 0, y: 1 },
		];
		const tx = 10;
		const ty = -5;
		const nodes: RunnerNode[] = truth.map((p, idx) =>
			makeNode({ id: idx + 1, trueX: p.x, trueY: p.y, estX: p.x + tx, estY: -p.y + ty })
		);
		expect(ale(nodes)).toBeGreaterThan(0.1);
		expect(aleAlignedRigid(nodes)).toBeCloseTo(0, 8);
	});

	it("rmseAlignedRigid is invariant to global rotation + translation", () => {
		const truth = [
			{ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 },
			{ id: 2, trueX: 2, trueY: 0, estX: 0, estY: 0 },
			{ id: 3, trueX: 0, trueY: 1, estX: 0, estY: 0 },
		];

		// Apply a rigid transform to the estimates.
		const theta = Math.PI / 3;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		const tx = 7;
		const ty = -4;

		const nodes = truth.map((p) => {
			const x = c * p.trueX - s * p.trueY + tx;
			const y = s * p.trueX + c * p.trueY + ty;
			return {
				id: p.id,
				trueX: p.trueX,
				trueY: p.trueY,
				txCount: 0,
				firmware: {
					estPosition: { x, y },
					neighbors: [],
					state: "STATIONARY",
					role: "IDLE",
				},
			};
		});

		// Raw RMSE should be non-zero due to frame mismatch.
		expect(rmse(nodes as any)).toBeGreaterThan(0.1);
		// Aligned RMSE should be ~0.
		expect(rmseAlignedRigid(nodes as any)).toBeCloseTo(0, 8);
	});

	it("rmseAlignedRigid can resolve a reflected solution (mirror) when needed", () => {
		const truth = [
			{ id: 1, trueX: 0, trueY: 0 },
			{ id: 2, trueX: 2, trueY: 0 },
			{ id: 3, trueX: 0, trueY: 1 },
		];
		const tx = 7;
		const ty = 2;
		const nodes = truth.map((p) => ({
			id: p.id,
			trueX: p.trueX,
			trueY: p.trueY,
			txCount: 0,
			firmware: {
				estPosition: { x: p.trueX + tx, y: -p.trueY + ty },
				neighbors: [],
				state: "STATIONARY",
				role: "IDLE",
			},
		}));
		expect(rmse(nodes as any)).toBeGreaterThan(0.1);
		expect(rmseAlignedRigid(nodes as any)).toBeCloseTo(0, 8);
	});

	it("aligned metrics do not penalize multiple disconnected clusters", () => {
		// Two 2-node clusters with different rigid frames.
		// Cluster A: nodes 1-2
		// Cluster B: nodes 3-4
		const nodes: RunnerNode[] = [
			{
				id: 1,
				trueX: 0,
				trueY: 0,
				batteryV: 3.7,
				txCount: 0,
				firmware: {
					estPosition: { x: 10, y: -5 },
					neighbors: [{ id: 2, rangeMeters: 1, angleRad: 0, timestamp: 0 } as NeighborObservation],
				} as FirmwareSnapshot,
			},
			{
				id: 2,
				trueX: 1,
				trueY: 0,
				batteryV: 3.7,
				txCount: 0,
				firmware: {
					// Same cluster A frame
					estPosition: { x: 10, y: -4 },
					neighbors: [{ id: 1, rangeMeters: 1, angleRad: 0, timestamp: 0 } as NeighborObservation],
				} as FirmwareSnapshot,
			},
			{
				id: 3,
				trueX: 10,
				trueY: 0,
				batteryV: 3.7,
				txCount: 0,
				firmware: {
					// Cluster B uses a different frame
					estPosition: { x: -20, y: 3 },
					neighbors: [{ id: 4, rangeMeters: 1, angleRad: 0, timestamp: 0 } as NeighborObservation],
				} as FirmwareSnapshot,
			},
			{
				id: 4,
				trueX: 11,
				trueY: 0,
				batteryV: 3.7,
				txCount: 0,
				firmware: {
					// Same cluster B frame
					estPosition: { x: -19, y: 3 },
					neighbors: [{ id: 3, rangeMeters: 1, angleRad: 0, timestamp: 0 } as NeighborObservation],
				} as FirmwareSnapshot,
			},
		];

		// Raw errors are non-zero (frame mismatch).
		expect(rmse(nodes as any)).toBeGreaterThan(0.1);
		expect(ale(nodes as any)).toBeGreaterThan(0.1);

		// Component-wise alignment should yield ~0.
		expect(rmseAlignedRigid(nodes as any)).toBeCloseTo(0, 8);
		expect(aleAlignedRigid(nodes as any)).toBeCloseTo(0, 8);
	});

	it("pairwiseDistanceMae is invariant to rigid transforms", () => {
		const theta = Math.PI / 4;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		const tx = 3.3;
		const ty = -2.2;
		const pts = [
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 3, y: 0 },
			{ id: 3, x: 0, y: 4 },
			{ id: 4, x: 2, y: 2 },
		];
		const nodes = pts.map((p) => {
			const ex = c * p.x - s * p.y + tx;
			const ey = s * p.x + c * p.y + ty;
			return {
				id: p.id,
				trueX: p.x,
				trueY: p.y,
				txCount: 0,
				firmware: {
					estPosition: { x: ex, y: ey },
					neighbors: [],
					state: "STATIONARY",
					role: "IDLE",
				},
			};
		});
		expect(pairwiseDistanceMae(nodes as any)).toBeCloseTo(0, 10);
	});

	it("pairwiseDistanceMae returns 0 for N<2", () => {
		const nodes: RunnerNode[] = [makeNode({ id: 1, trueX: 0, trueY: 0, estX: 5, estY: 0 })];
		expect(pairwiseDistanceMae(nodes as any)).toBe(0);
	});

	it("rmseAlignedRigid returns NaN if any estimate is non-finite", () => {
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 }),
			makeNode({ id: 2, trueX: 1, trueY: 0, estX: Number.POSITIVE_INFINITY, estY: 0 }),
		];
		expect(Number.isNaN(rmseAlignedRigid(nodes as any))).toBe(true);
	});

	it("rmseAlignedRigid falls back to raw RMSE for N<2", () => {
		const nodes: RunnerNode[] = [makeNode({ id: 1, trueX: 0, trueY: 0, estX: 5, estY: 0 })];
		expect(rmseAlignedRigid(nodes as any)).toBeCloseTo(5, 12);
	});

	it("pairwiseDistanceMae returns NaN if any estimate is non-finite", () => {
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 }),
			makeNode({ id: 2, trueX: 1, trueY: 0, estX: Number.NaN, estY: 0 }),
		];
		expect(Number.isNaN(pairwiseDistanceMae(nodes as any))).toBe(true);
	});

	it("aleAlignedRigid returns NaN if any estimate is non-finite", () => {
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 }),
			makeNode({ id: 2, trueX: 1, trueY: 0, estX: Number.NaN, estY: 0 }),
		];
		expect(Number.isNaN(aleAlignedRigid(nodes))).toBe(true);
	});

	it("aleAlignedRigid falls back to raw ALE for N<2", () => {
		const nodes: RunnerNode[] = [makeNode({ id: 1, trueX: 0, trueY: 0, estX: 5, estY: 0 })];
		expect(aleAlignedRigid(nodes)).toBeCloseTo(5, 12);
	});

	it("rmse is always >= mae (basic inequality)", () => {
		// For non-negative errors, RMS >= arithmetic mean.
		// We test many deterministic random configurations to guard against regressions.
		const rng = mulberry32(12345);
		for (let trial = 0; trial < 200; trial++) {
			const n = 2 + Math.floor(rng() * 30);
			const nodes: RunnerNode[] = [];
			for (let i = 0; i < n; i++) {
				const trueX = (rng() - 0.5) * 10;
				const trueY = (rng() - 0.5) * 10;
				// Generate an error vector with variable magnitude.
				const errMag = rng() * 5;
				const theta = rng() * 2 * Math.PI;
				const estX = trueX + errMag * Math.cos(theta);
				const estY = trueY + errMag * Math.sin(theta);
				nodes.push(makeNode({ id: i + 1, trueX, trueY, estX, estY }));
			}
			const m = mae(nodes);
			const r = rmse(nodes);
			expect(r + 1e-12).toBeGreaterThanOrEqual(m);
		}
	});

	it("rmse equals mae when all per-node errors are identical", () => {
		// If all errors have the same magnitude, RMS == mean.
		const err = 2.5;
		const nodes: RunnerNode[] = [
			makeNode({ id: 1, trueX: 0, trueY: 0, estX: err, estY: 0 }),
			makeNode({ id: 2, trueX: 1, trueY: 0, estX: 1 - err, estY: 0 }),
			makeNode({ id: 3, trueX: 0, trueY: 1, estX: 0, estY: 1 + err }),
			makeNode({ id: 4, trueX: -1, trueY: -1, estX: -1, estY: -1 - err }),
		];
		expect(mae(nodes)).toBeCloseTo(err, 12);
		expect(rmse(nodes)).toBeCloseTo(err, 12);
	});

	it("measurementRangeResidualMae computes MAE over observed neighbor ranges (undirected dedupe)", () => {
		const n1 = makeNode({ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 });
		const n2 = makeNode({ id: 2, trueX: 0, trueY: 0, estX: 3, estY: 4 });
		// Pred distance is 5. Measured is 5.5 => residual 0.5
		n1.firmware.neighbors = [{ id: 2, rangeMeters: 5.5, timestamp: 0 } satisfies NeighborObservation];
		// Duplicate opposite direction should be ignored (undirected dedupe)
		n2.firmware.neighbors = [{ id: 1, rangeMeters: 5.5, timestamp: 0 } satisfies NeighborObservation];
		expect(measurementRangeResidualMae([n1, n2])).toBeCloseTo(0.5, 12);
	});

	it("measurementAngleResidualMae computes MAE over directed AoA/bearing residuals with wrapping", () => {
		const n1 = makeNode({ id: 1, trueX: 0, trueY: 0, estX: 0, estY: 0 });
		const n2 = makeNode({ id: 2, trueX: 0, trueY: 0, estX: 1, estY: 0 });
		// True bearing from 1->2 is 0. Use an angle near +pi to force wrap.
		n1.firmware.neighbors = [
			{ id: 2, rangeMeters: 1, angleRad: Math.PI - 0.05, timestamp: 0 } satisfies NeighborObservation,
		];
		// Error should be wrap(0 - (pi-0.05)) ~= -(pi-0.05) -> abs ~= pi-0.05
		// Now add second directed observation with near -pi to ensure wrapping gives small residual.
		n2.firmware.neighbors = [
			{ id: 1, rangeMeters: 1, angleRad: -Math.PI + 0.02, timestamp: 0 } satisfies NeighborObservation,
		];
		// Bearing 2->1 is pi. Residual wrap(pi - (-pi+0.02)) = wrap(2pi-0.02) ~= -0.02
		const maeRad = measurementAngleResidualMae([n1, n2]);
		expect(maeRad).toBeCloseTo((Math.PI - 0.05 + 0.02) / 2, 10);
	});
});
