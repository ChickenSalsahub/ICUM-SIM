import { describe, expect, it } from "vitest";
import type { FirmwareSnapshot } from "../../firmware/types.ts";
import type { RunnerSnapshot } from "../lib/types.ts";
import { ale, aleAlignedRigid, mae, rmse } from "../lib/metrics.ts";

type RunnerNode = RunnerSnapshot["nodes"][number];

type PartialFirmware = Pick<FirmwareSnapshot, "estPosition">;

function makeNode(args: { id: number; trueX: number; trueY: number; estX: number; estY: number }): RunnerNode {
	const firmware: PartialFirmware = {
		estPosition: { x: args.estX, y: args.estY },
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
});
