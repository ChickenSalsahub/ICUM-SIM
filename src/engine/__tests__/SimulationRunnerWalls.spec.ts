import { describe, expect, it } from "vitest";
import { SimulationRunner } from "../SimulationRunner";

// Tests LOS wall collision handling for node movement.

describe("SimulationRunner wall collisions", () => {
	it("stops movement when crossing a wall segment", () => {
		const runner = new SimulationRunner({
			uwbRangeMeters: 15,
			packetLoss: 0,
			worldBounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
		});

		runner.setWalls([
			// Vertical wall at x=0.5m
			{ id: "w", x1: 0.5, y1: -5, x2: 0.5, y2: 5 },
		]);

		runner.addNode(1, { x: 0, y: 0 }, { vx: 1, vy: 0 }, 3.7, false);

		runner.step(1000);
		let snap = runner.snapshot();
		expect(snap.nodes[0].trueX).toBeCloseTo(0, 8);
		expect(snap.nodes[0].trueY).toBeCloseTo(0, 8);

		// A second step should still not move (velocity should have been zeroed).
		runner.step(1000);
		snap = runner.snapshot();
		expect(snap.nodes[0].trueX).toBeCloseTo(0, 8);
	});
});
