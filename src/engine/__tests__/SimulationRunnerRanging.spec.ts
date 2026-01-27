import { describe, expect, it } from "vitest";
import { SimulationRunner } from "../SimulationRunner";

// Tests UWB ranging payload injection, perceived vs truth distances, and angle handling.

function bearingRad(from: { x: number; y: number }, to: { x: number; y: number }): number {
	return Math.atan2(to.y - from.y, to.x - from.x);
}

function wrapPi(a: number): number {
	let x = (a + Math.PI) % (2 * Math.PI);
	if (x < 0) x += 2 * Math.PI;
	return x - Math.PI;
}

function absAngleErrorRad(a: number, b: number): number {
	return Math.abs(wrapPi(a - b));
}

describe("SimulationRunner ranging: truth vs perceived", () => {
	it("event-driven does not emit UWB_BLINK when stationary", () => {
		const runner = new SimulationRunner({
			seed: 321,
			packetLoss: 0,
			uwbRangeMeters: 100,
			uwbNoiseSigma: 0,
			uwbAngleNoiseStdRad: 0,
			firmwareConfig: {
				eventDrivenSensing: true,
				helloIntervalIdleMs: 10_000,
			},
		});

		runner.addNode(1, { x: 0, y: 0 }, { vx: 0, vy: 0 }, 3.7, false);
		runner.addNode(2, { x: 3, y: 4 }, { vx: 0, vy: 0 }, 3.7, false);

		let blinkCount = 0;
		runner.setHooks({
			onDeliver: (evt) => {
				if (evt.packet.payload?.type === "UWB_BLINK") blinkCount += 1;
			},
		});

		runner.step(2_000);
		expect(blinkCount).toBe(0);
	});

	it("event-driven emits UWB_BLINK when moving", () => {
		const runner = new SimulationRunner({
			seed: 322,
			packetLoss: 0,
			uwbRangeMeters: 100,
			uwbNoiseSigma: 0,
			uwbAngleNoiseStdRad: 0,
			firmwareConfig: {
				eventDrivenSensing: true,
			},
		});

		runner.addNode(1, { x: 0, y: 0 }, { vx: 0.2, vy: 0 }, 3.7, false);
		runner.addNode(2, { x: 3, y: 4 }, { vx: 0, vy: 0 }, 3.7, false);

		let blinkCount = 0;
		runner.setHooks({
			onDeliver: (evt) => {
				if (evt.packet.payload?.type === "UWB_BLINK") blinkCount += 1;
			},
		});

		runner.step(2_000);
		expect(blinkCount).toBeGreaterThan(0);
	});

	it("exposes correct true distance and injected payload angle/range when noise=0", () => {
		const runner = new SimulationRunner({
			seed: 123,
			packetLoss: 0,
			uwbRangeMeters: 100,
			uwbNoiseSigma: 0,
			uwbAngleNoiseStdRad: 0,
			firmwareConfig: {
				// Make sure we transmit quickly in tests.
				eventDrivenSensing: false,
				helloIntervalMovingMs: 50,
				helloIntervalIdleMs: 50,
				rangingIntervalMovingMs: 50,
				rangingIntervalIdleMs: 50,
			},
		});

		runner.addNode(1, { x: 0, y: 0 }, { vx: 0, vy: 0 }, 3.7, false);
		runner.addNode(2, { x: 3, y: 4 }, { vx: 0, vy: 0 }, 3.7, false);

		type Deliver = Parameters<NonNullable<NonNullable<Parameters<SimulationRunner["setHooks"]>[0]>["onDeliver"]>>[0];
		const deliveries: Deliver[] = [];
		runner.setHooks({
			onDeliver: (evt) => {
				if (evt.packet.payload?.type !== "UWB_BLINK") return;
				deliveries.push(evt);
			},
		});

		runner.step(2_000);

		// Expect both directions.
		const a = deliveries.find((d) => d.senderId === 1 && d.recipientId === 2);
		const b = deliveries.find((d) => d.senderId === 2 && d.recipientId === 1);
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();

		for (const d of [a!, b!]) {
			const sender = d.senderId === 1 ? { x: 0, y: 0 } : { x: 3, y: 4 };
			const recipient = d.recipientId === 1 ? { x: 0, y: 0 } : { x: 3, y: 4 };
			const expectedDist = Math.hypot(sender.x - recipient.x, sender.y - recipient.y);
			const expectedAngle = bearingRad(recipient, sender); // recipient(self) -> sender(neighbor)

			expect(d.ranging?.trueDistanceMeters).toBeCloseTo(expectedDist, 12);
			expect(d.packet.payload?.range).toBeCloseTo(expectedDist, 12);
			expect(d.packet.payload?.angle).toBeCloseTo(expectedAngle, 12);
		}
	});

	it("firmware neighbor table reflects perceived (injected) range/angle", () => {
		const runner = new SimulationRunner({
			seed: 999,
			packetLoss: 0,
			uwbRangeMeters: 100,
			uwbNoiseSigma: 0.5,
			uwbAngleNoiseStdRad: 0,
			firmwareConfig: {
				eventDrivenSensing: false,
				helloIntervalMovingMs: 50,
				helloIntervalIdleMs: 50,
				rangingIntervalMovingMs: 50,
				rangingIntervalIdleMs: 50,
			},
		});

		runner.addNode(1, { x: 0, y: 0 }, { vx: 0, vy: 0 }, 3.7, false);
		runner.addNode(2, { x: 3, y: 4 }, { vx: 0, vy: 0 }, 3.7, false);

		let lastMeasured: { range: number; angle: number } | undefined;
		runner.setHooks({
			onDeliver: (evt) => {
				if (evt.packet.payload?.type !== "UWB_BLINK") return;
				if (evt.senderId === 1 && evt.recipientId === 2) {
					lastMeasured = {
						range: evt.packet.payload.range,
						angle: evt.packet.payload.angle,
					};
				}
			},
		});

		runner.step(2_000);
		expect(lastMeasured).toBeTruthy();

		const snap = runner.snapshot();
		const node2 = snap.nodes.find((n) => n.id === 2);
		expect(node2).toBeTruthy();
		const obs = node2!.firmware.neighbors.find((n) => n.id === 1);
		expect(obs).toBeTruthy();

		expect(obs!.rangeMeters).toBeCloseTo(lastMeasured!.range, 12);
		expect(obs!.angleRad).toBeCloseTo(lastMeasured!.angle, 12);
	});

	it("can compute measurement error vs truth (range + bearing)", () => {
		const sender = { x: 0, y: 0 };
		const recipient = { x: 3, y: 4 };
		const truthDist = Math.hypot(sender.x - recipient.x, sender.y - recipient.y);
		const truthAngle = bearingRad(recipient, sender);

		// Pretend a measured packet arrived (range noisy, bearing perfect).
		const measuredRange = truthDist + 0.25;
		const measuredAngle = truthAngle;

		const rangeAbsErr = Math.abs(measuredRange - truthDist);
		const angleAbsErr = absAngleErrorRad(measuredAngle, truthAngle);

		expect(rangeAbsErr).toBeCloseTo(0.25, 12);
		expect(angleAbsErr).toBeCloseTo(0, 12);

		// Also validate wrapping behavior for angles near +/-pi.
		const a = Math.PI - 1e-6;
		const b = -Math.PI + 1e-6;
		expect(absAngleErrorRad(a, b)).toBeCloseTo(2e-6, 12);
	});
});
