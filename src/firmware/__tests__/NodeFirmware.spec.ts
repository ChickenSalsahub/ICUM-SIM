import { describe, it, expect } from "vitest";
import { NodeFirmware } from "../NodeFirmware";
import { INodeHAL, ImuSample } from "../types";
import { Packet, PacketType } from "../../types";

const makeHal = (opts: { linearAccelG?: number; batteryV?: number; now?: number }) => {
	let radioOut: Packet[] = [];
	const imu: ImuSample = {
		// Firmware subtracts gravity; represent a linear x-acceleration cue.
		accel: { x: (opts.linearAccelG ?? 0) * 9.81, y: 0, z: 9.81 },
		gyro: { x: 0, y: 0, z: 0 },
	};
	const hal: INodeHAL = {
		getIMU: () => imu,
		pollRadio: () => [],
		getBatteryVoltage: () => opts.batteryV ?? 3.7,
		getTimeMs: () => opts.now ?? 0,
		radioSend: (p) => radioOut.push(p),
		log: () => {},
	};
	return { hal, radioOut };
};

describe("NodeFirmware FSM", () => {
	it("transitions to MOVING when accel > 0.5G", () => {
		const { hal } = makeHal({ linearAccelG: 0.6 });
		const fw = new NodeFirmware(1, hal);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");
	});

	it("can become ISOLATED even when stationary", () => {
		let now = 0;
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => [];

		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 1_000 });

		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");

		now = 2_000;
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("ISOLATED");
	});

	it("recovers from ISOLATED when connectivity returns", () => {
		let now = 0;
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;

		let deliverOnce = false;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			if (!deliverOnce) return [];
			deliverOnce = false;
			return [
				{
					id: "hello-2",
					type: PacketType.DATA,
					srcId: 2,
					destId: -1,
					payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
					timestamp: now,
				},
			];
		};

		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 1_000 });

		fw.tick(100);
		now = 2_000;
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("ISOLATED");

		now = 2_100;
		deliverOnce = true;
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");
	});
});

describe("Leader Election", () => {
	it("does not self-elect when alone", () => {
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now: 0 });
		const fw = new NodeFirmware(1, hal);
		fw.tick(100);
		const snap = fw.getSnapshot();
		expect(snap.leaderId).toBe(null);
		expect(snap.role).toBe("IDLE");
	});

	it("prefers higher battery when connectivity equal", () => {
		const now = 0;
		const { hal } = makeHal({ linearAccelG: 0.1, batteryV: 3.7, now });
		const fw = new NodeFirmware(1, hal);
		// inject neighbor via fake radio packet
		(hal.pollRadio as unknown as () => Packet[]) = () => [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
				timestamp: now,
			},
		];
		fw.tick(100);
		const snap = fw.getSnapshot();
		expect(snap.leaderId).toBe(2);
	});

	it("re-elects when leader goes stale", () => {
		let now = 0;
		const { hal } = makeHal({ linearAccelG: 0.1, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;

		let deliverHello = true;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			if (!deliverHello) return [];
			deliverHello = false;
			return [
				{
					id: "hello-2",
					type: PacketType.DATA,
					srcId: 2,
					destId: -1,
					payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
					timestamp: now,
				},
			];
		};

		const fw = new NodeFirmware(1, hal, { neighborTimeoutMs: 1_000 });
		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(2);

		// Advance time beyond neighbor timeout without receiving anything.
		now = 2_000;
		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(null);
		expect(fw.getSnapshot().role).toBe("IDLE");
	});
});

describe("Adaptive sensing cadence", () => {
	it("slows ranging when stationary+stable, resumes on topology change", () => {
		let now = 0;
		let radioOut: Packet[] = [];
		let inbound: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => ({ accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
			pollRadio: () => {
				const items = inbound;
				inbound = [];
				return items;
			},
			getBatteryVoltage: () => 3.7,
			getTimeMs: () => now,
			radioSend: (p) => radioOut.push(p),
			log: () => {},
		};

		const fw = new NodeFirmware(1, hal, { neighborTimeoutMs: 100_000, isolationNoAckMs: 100_000 });

		// Introduce neighbor 2 at t=0 (topology change window begins).
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
				timestamp: now,
			},
		];
		fw.tick(100);

		// At t=1000ms we should be in fast mode: send both HELLO and RANGING_POLL.
		now = 1_000;
		radioOut = [];
		fw.tick(100);
		expect(radioOut.some((p) => p.payload?.type === "RANGING_POLL")).toBe(true);
		expect(radioOut.some((p) => p.payload?.type === "HELLO")).toBe(true);

		// After topology recency window passes, ranging should be slowed (10s interval).
		// At t=6001ms (only ~5s since last ranging poll), we should NOT see another ranging poll.
		now = 6_001;
		radioOut = [];
		fw.tick(100);
		expect(radioOut.some((p) => p.payload?.type === "RANGING_POLL")).toBe(false);

		// Topology change (neighbor 3 appears) should immediately re-enable fast ranging.
		now = 7_000;
		inbound = [
			{
				id: "hello-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
				timestamp: now,
			},
		];
		radioOut = [];
		fw.tick(100);
		expect(radioOut.some((p) => p.payload?.type === "RANGING_POLL")).toBe(true);
	});

	it("suppresses periodic ranging when stationary+stable and measurements are known (event-driven)", () => {
		let now = 0;
		let radioOut: Packet[] = [];
		let inbound: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => ({ accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
			pollRadio: () => {
				const items = inbound;
				inbound = [];
				return items;
			},
			getBatteryVoltage: () => 3.7,
			getTimeMs: () => now,
			radioSend: (p) => radioOut.push(p),
			log: () => {},
		};

		const fw = new NodeFirmware(1, hal, {
			neighborTimeoutMs: 100_000,
			isolationNoAckMs: 100_000,
			eventDrivenSensing: true,
			// Make it easy for the test to fail if periodic ranging leaks through.
			rangingIntervalIdleMs: 1_000,
			rangingIntervalMovingMs: 1_000,
			rangingMaintenanceMs: 0,
			// Avoid HELLO noise in assertions.
			helloIntervalIdleMs: 100_000,
		});

		// Seed neighbor + a real measurement (range+angle) so "needsLearning" becomes false.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.HELLO,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.0, degree: 1 },
				timestamp: now,
			},
			{
				id: "resp-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: 1,
				payload: { type: "RANGING_RESP", range: 5, angle: 0.25, batteryV: 4.0, degree: 1 },
				timestamp: now,
			},
		];
		fw.tick(100);

		// After topology recency window passes (5s), stationary+stable should not poll periodically.
		now = 7_000;
		radioOut = [];
		fw.tick(100);
		expect(radioOut.some((p) => p.payload?.type === "RANGING_POLL")).toBe(false);

		// Even much later, still no periodic ranging (maintenance disabled).
		now = 25_000;
		radioOut = [];
		fw.tick(100);
		expect(radioOut.some((p) => p.payload?.type === "RANGING_POLL")).toBe(false);
	});
});
