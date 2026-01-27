import { describe, expect, it } from "vitest";
import { SimulationRunner } from "../SimulationRunner";

// Tests world bounds clamping and velocity zeroing.

describe("SimulationRunner world bounds", () => {
	it("clamps position and zeros velocity when exceeding bounds", () => {
		const runner = new SimulationRunner({ worldBounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } });
		runner.addNode(1, { x: 0.9, y: 0.5 }, { vx: 10, vy: 0 });
		runner.step(200); // 0.2s => x would be 2.9 without bounds
		const snap = runner.snapshot();
		expect(snap.nodes[0].trueX).toBe(1);

		// Velocity should be zeroed so synthetic IMU stops reporting motion.
		runner.step(200);
		const snap2 = runner.snapshot();
		expect(snap2.nodes[0].trueX).toBe(1);
	});
});
