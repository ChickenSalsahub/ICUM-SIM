import { describe, expect, it } from "vitest";
import { NodeFirmware } from "../firmware/NodeFirmware";
import type { INodeHAL, ImuSample } from "../firmware/types";
import { Packet, PacketType } from "../types";

/**
 * HAL stub to control time, IMU, and inbound packets.
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

describe("Isolation timeout (safety net)", () => {
	it("isolates after 30s without ACK and recovers on HELLO", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		setAccelG(0.6);

		const fw = new NodeFirmware(1, hal, {
			isolationNoAckMs: 30_000,
			neighborTimeoutMs: 30_000,
			helloIntervalIdleMs: 10_000,
		});

		// Start in MOVING state.
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// 29s without ACKs: still MOVING (not isolated yet).
		setNow(29_000);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// >30s without ACKs: becomes ISOLATED.
		setNow(30_100);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("ISOLATED");

		// Recover via HELLO while stationary.
		setAccelG(0.0);
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 1, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 30_200,
		});
		setNow(30_200);
		fw.tick(100);
		const state = fw.getSnapshot().state;
		expect(state === "STATIONARY" || state === "MOVING").toBe(true);
	});

	it("does not isolate if mesh traffic arrives before timeout", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		setNow(0);
		setAccelG(0.6);

		const fw = new NodeFirmware(1, hal, {
			isolationNoAckMs: 30_000,
			neighborTimeoutMs: 30_000,
			helloIntervalIdleMs: 10_000,
		});

		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// Receive a HELLO before 30s passes.
		setNow(20_000);
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.9, degree: 1, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 20_000,
		});
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// Still under timeout window; should not isolate.
		setNow(29_000);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");
	});
});
