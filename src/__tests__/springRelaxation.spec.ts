import { describe, expect, it } from "vitest";
import { NodeFirmware } from "../firmware/NodeFirmware";
import type { INodeHAL, ImuSample } from "../firmware/types";
import { Packet, PacketType } from "../types";

/**
 * Minimal HAL stub for graph optimization.
 * We only need IMU, time, and a single inbound packet.
 */
const makeHal = () => {
	let now = 0;
	let accelG = 0;
	let inbound: Packet[] = [];
	const radioOut: Packet[] = [];

	const imu: ImuSample = {
		accel: { x: 0, y: 0, z: 9.81 },
		gyro: { x: 0, y: 0, z: 0 },
	};

	const hal: INodeHAL = {
		getIMU: () => ({ ...imu, accel: { x: accelG * 9.81, y: 0, z: 9.81 } }),
		pollRadio: () => {
			const items = inbound;
			inbound = [];
			return items;
		},
		getBatteryVoltage: () => 3.7,
		getTimeMs: () => now,
		getGlobalPosition: () => null,
		radioSend: (p) => radioOut.push(p),
		log: () => {},
	};

	return {
		hal,
		radioOut,
		setNow: (t: number) => {
			now = t;
		},
		setAccelG: (g: number) => {
			accelG = g;
		},
		pushInbound: (p: Packet) => inbound.push(p),
	};
};

describe("Spring-relaxation graph optimization", () => {
	it("moves 0.2m toward neighbor when dist=10 and range=9", () => {
		const a = makeHal();
		a.setNow(0);
		a.setAccelG(0);

		const fwA = new NodeFirmware(1, a.hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
		});

		// Neighbor believed at (10, 0) with measured range 9m.
		// dist = 10, range = 9 => eDist = 1.0, alpha = 0.2 => move +0.2 in +x.
		a.pushInbound({
			id: "blink-2",
			type: PacketType.UWB_BLINK,
			srcId: 2,
			destId: -1,
			payload: {
				type: "UWB_BLINK",
				range: 9,
				angle: 0,
				estX: 10,
				estY: 0,
				status: "STATIONARY",
			},
			timestamp: 0,
		});

		fwA.tick(100);

		const estA = fwA.getSnapshot().estPosition;
		expect(estA.x).toBeCloseTo(0.2, 6);
		expect(estA.y).toBeCloseTo(0, 6);
	});

	it("does not move when range matches estimated distance", () => {
		const a = makeHal();
		a.setNow(0);
		a.setAccelG(0);

		const fwA = new NodeFirmware(1, a.hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
		});

		a.pushInbound({
			id: "blink-2",
			type: PacketType.UWB_BLINK,
			srcId: 2,
			destId: -1,
			payload: {
				type: "UWB_BLINK",
				range: 10,
				angle: 0,
				estX: 10,
				estY: 0,
				status: "STATIONARY",
			},
			timestamp: 0,
		});

		fwA.tick(100);

		const estA = fwA.getSnapshot().estPosition;
		expect(estA.x).toBeCloseTo(0, 6);
		expect(estA.y).toBeCloseTo(0, 6);
	});

	it("ignores invalid measurements (zero/negative range)", () => {
		const a = makeHal();
		a.setNow(0);
		a.setAccelG(0);

		const fwA = new NodeFirmware(1, a.hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
		});

		a.pushInbound({
			id: "blink-2",
			type: PacketType.UWB_BLINK,
			srcId: 2,
			destId: -1,
			payload: {
				type: "UWB_BLINK",
				range: 0,
				angle: 0,
				estX: 10,
				estY: 0,
				status: "STATIONARY",
			},
			timestamp: 0,
		});

		fwA.tick(100);

		const estA = fwA.getSnapshot().estPosition;
		expect(estA.x).toBeCloseTo(0, 6);
		expect(estA.y).toBeCloseTo(0, 6);
	});
});
