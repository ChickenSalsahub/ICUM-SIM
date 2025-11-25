import { describe, it, expect } from "vitest";
import { CoopLocEngine } from "../CooperativeLocalization";
import { VectorUtils } from "../../math/VectorUtils";

describe("CooperativeLocalization", () => {
	it("should initialize with self at origin", () => {
		const engine = new CoopLocEngine(1);
		const pose = engine.getLocalPose(1);
		expect(pose).toEqual({ x: 0, y: 0, theta: 0 });
	});

	it("should update position based on odometry", () => {
		const engine = new CoopLocEngine(1);
		engine.update(0.1, [], { dx: 1, dy: 0, dTheta: 0, timestamp: 0 });

		const pose = engine.getLocalPose(1);
		expect(pose?.x).toBeCloseTo(1);
		expect(pose?.y).toBeCloseTo(0);
	});

	it("should adjust relative positions based on range measurements", () => {
		const engine = new CoopLocEngine(1);
		// Node 2 is 10m away
		engine.update(0.1, [{ peerId: 2, range: 10, timestamp: 0 }]);

		const pose2 = engine.getLocalPose(2);
		expect(pose2).toBeDefined();

		// Distance should be close to 10
		const dist = VectorUtils.dist({ x: 0, y: 0 }, pose2!);
		expect(dist).toBeCloseTo(10, 1);
	});

	it("should solve a 3-node triangle", () => {
		// Node 1 (Self) at (0,0)
		// Node 2 at (10,0)
		// Node 3 at (0,10)
		// Distances: 1-2=10, 1-3=10, 2-3=14.14

		const engine = new CoopLocEngine(1);

		// Iterative updates to simulate convergence
		for (let i = 0; i < 50; i++) {
			engine.update(0.1, [
				{ peerId: 2, range: 10, timestamp: 0 },
				{ peerId: 3, range: 10, timestamp: 0 },
			]);

			// We also need to tell the engine about the constraint between 2 and 3
			// In a real system, this comes from gossip.
			engine.processNeighborInfo(2, [{ id: 3, range: 14.142 }]);
		}

		const p2 = engine.getLocalPose(2)!;
		const p3 = engine.getLocalPose(3)!;

		const d12 = VectorUtils.dist({ x: 0, y: 0 }, p2);
		const d13 = VectorUtils.dist({ x: 0, y: 0 }, p3);
		const d23 = VectorUtils.dist(p2, p3);

		expect(d12).toBeCloseTo(10, 0.5);
		expect(d13).toBeCloseTo(10, 0.5);
		expect(d23).toBeCloseTo(14.14, 0.5);
	});

	it("should transform to global coordinates when anchor is set", () => {
		const engine = new CoopLocEngine(1);
		// Self is at (0,0) local.
		// Set global ref to (0,0) Lat/Lng
		engine.setGlobalReference(0, 0);

		const global = engine.getGlobalPosition(1);
		expect(global?.lat).toBeCloseTo(0);
		expect(global?.lng).toBeCloseTo(0);

		// Move self 111km North (approx 1 deg lat)
		// 111,132 meters
		engine.update(0.1, [], { dx: 0, dy: 111132.92, dTheta: 0, timestamp: 0 });

		const newGlobal = engine.getGlobalPosition(1);
		expect(newGlobal?.lat).toBeCloseTo(1, 3);
		expect(newGlobal?.lng).toBeCloseTo(0, 3);
	});
});
