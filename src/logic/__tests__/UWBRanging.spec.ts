import { describe, it, expect } from "vitest";
import { UWBRanging } from "../UWBRanging";

// Tests UWB ranging LOS success and wall-blocked failure cases.

describe("UWBRanging", () => {
	it("measures true distance with LOS", () => {
		// deterministic rng for test
		const rng = () => 0.5;
		const pixelsPerMeter = 10;
		const engine = new UWBRanging(pixelsPerMeter, { rng, noiseStdMeters: 0 });

		const a = { id: 1, x: 0, y: 0 };
		const b = { id: 2, x: 0, y: 100 }; // 10 meters apart

		const res = engine.measure(a, b, { pixelsPerMeter, maxRangeMeters: 20 });
		expect(res.success).toBe(true);
		expect(Math.abs(res.trueDistanceMeters - 10)).toBeLessThan(1e-6);
		expect(Math.abs(res.measuredDistanceMeters - 10)).toBeLessThan(1e-6);
		expect(res.los).toBe(true);
	});

	it("fails when blocked by wall", () => {
		const rng = () => 0.5;
		const pixelsPerMeter = 10;
		const engine = new UWBRanging(pixelsPerMeter, { rng, noiseStdMeters: 0 });

		const a = { id: 1, x: 0, y: 0 };
		const b = { id: 2, x: 0, y: 100 };
		const walls = [{ id: "w1", x1: -10, y1: 50, x2: 10, y2: 50 }];

		const res = engine.measure(a, b, { pixelsPerMeter, maxRangeMeters: 20, walls });
		expect(res.success).toBe(false);
		expect(res.error).toBeDefined();
		expect(res.los).toBe(false);
	});
});
