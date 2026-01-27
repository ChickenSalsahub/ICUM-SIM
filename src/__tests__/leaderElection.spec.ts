import { describe, expect, it } from "vitest";
import { NodeFirmware } from "../firmware/NodeFirmware";
import type { INodeHAL, ImuSample } from "../firmware/types";
import { Packet, PacketType } from "../types";

/**
 * HAL stub with inbound HELLO packets so we can control the candidate table.
 */
const makeHal = () => {
	let now = 0;
	let accelG = 0;
	let inbound: Packet[] = [];
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
		radioSend: () => {},
		log: () => {},
	};

	return {
		hal,
		setNow: (t: number) => {
			now = t;
		},
		setAccelG: (g: number) => {
			accelG = g;
		},
		pushInbound: (p: Packet) => inbound.push(p),
	};
};

describe("Battery-aware leader election", () => {
	it("step 1: LTE backhaul wins", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		setAccelG(0);

		const fw = new NodeFirmware(42, hal, { isolationNoAckMs: 100_000 });

		// Candidate A: LTE backhaul, moderate battery/degree.
		pushInbound({
			id: "hello-5",
			type: PacketType.DATA,
			srcId: 5,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 3, hasBackhaul: true, status: "STATIONARY" },
			timestamp: 0,
		});
		// Candidate B: no backhaul, same battery/degree.
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 3, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});

		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(5);
	});

	it("step 2: higher battery wins when no backhaul", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		setAccelG(0);

		const fw = new NodeFirmware(42, hal, { isolationNoAckMs: 100_000 });

		// Candidate A: higher battery.
		pushInbound({
			id: "hello-5",
			type: PacketType.DATA,
			srcId: 5,
			destId: -1,
			payload: { type: "HELLO", batteryV: 4.1, degree: 3, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});
		// Candidate B: lower battery.
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 3, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});

		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(5);
	});

	it("step 3: lower ID wins tie", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		setAccelG(0);

		const fw = new NodeFirmware(42, hal, { isolationNoAckMs: 100_000 });

		// Same backhaul/degree/battery -> lower ID should win.
		pushInbound({
			id: "hello-5",
			type: PacketType.DATA,
			srcId: 5,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 3, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 3, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});

		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(2);
	});

	it("ignores moving candidates", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		// Make this node MOVING so it is not eligible to self-elect.
		setAccelG(0.6);

		const fw = new NodeFirmware(42, hal, { isolationNoAckMs: 100_000 });

		// Candidate A: moving, should be ignored.
		pushInbound({
			id: "hello-5",
			type: PacketType.DATA,
			srcId: 5,
			destId: -1,
			payload: { type: "HELLO", batteryV: 4.2, degree: 10, hasBackhaul: true, status: "MOVING" },
			timestamp: 0,
		});
		// Candidate B: stationary, should win.
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.5, degree: 2, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 0,
		});

		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(2);
	});

	it("no neighbors -> no leader", () => {
		const { hal, setNow, setAccelG } = makeHal();
		setNow(0);
		setAccelG(0);

		const fw = new NodeFirmware(42, hal, { isolationNoAckMs: 100_000 });
		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBeNull();
		expect(fw.getSnapshot().role).toBe("IDLE");
	});
});
