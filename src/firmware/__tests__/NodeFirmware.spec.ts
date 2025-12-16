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
