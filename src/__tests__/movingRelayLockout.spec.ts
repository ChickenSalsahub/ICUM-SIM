import { describe, expect, it } from "vitest";
import { NodeFirmware } from "../firmware/NodeFirmware";
import type { INodeHAL, ImuSample } from "../firmware/types";
import { Packet, PacketType } from "../types";

/**
 * Moving nodes must not act as relays/leaders.
 *
 * This test proves that when the IMU reports motion, the node immediately
 * drops relay eligibility and refuses to self-elect even with high battery.
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
		getBatteryVoltage: () => 4.2,
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

describe("Moving node relay lockout", () => {
	it("turns off relay/leadership when MOVING", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000 });

		// 1) Stationary: neighbor with LTE backhaul makes us a RELAY.
		setNow(0);
		setAccelG(0.0);
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.6, degree: 3, hasBackhaul: true, status: "STATIONARY" },
			timestamp: 0,
		});
		fw.tick(100);
		expect(fw.getSnapshot().role).toBe("RELAY");

		// 2) IMU spike: immediately become MOVING and drop relay role.
		setNow(200);
		setAccelG(1.5);
		fw.tick(100);
		const movingSnap = fw.getSnapshot();
		expect(movingSnap.state).toBe("MOVING");
		expect(movingSnap.role).toBe("IDLE");

		// 3) Even with high battery, moving nodes must not self-elect.
		pushInbound({
			id: "hello-3",
			type: PacketType.DATA,
			srcId: 3,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.1, degree: 1, hasBackhaul: false, status: "STATIONARY" },
			timestamp: 300,
		});
		setNow(300);
		fw.tick(100);
		const snap = fw.getSnapshot();
		expect(snap.state).toBe("MOVING");
		expect(snap.role).toBe("IDLE");
		expect(snap.leaderId).not.toBe(1);
	});

	it("keeps relay role when stationary", () => {
		const { hal, setNow, setAccelG, pushInbound } = makeHal();
		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000 });

		setNow(0);
		setAccelG(0.0);
		pushInbound({
			id: "hello-2",
			type: PacketType.DATA,
			srcId: 2,
			destId: -1,
			payload: { type: "HELLO", batteryV: 3.6, degree: 3, hasBackhaul: true, status: "STATIONARY" },
			timestamp: 0,
		});
		fw.tick(100);
		const snap = fw.getSnapshot();
		expect(snap.state).toBe("STATIONARY");
		expect(snap.role).toBe("RELAY");
	});
});
