import { describe, expect, it } from "vitest";
import { NodeFirmware } from "../firmware/NodeFirmware";
import type { INodeHAL, ImuSample } from "../firmware/types";

// No packets needed for this test; we focus on IMU-driven state changes.
/**
 * Minimal HAL stub for IMU-driven state transitions.
 * Only IMU, time, and battery are relevant for this test.
 */
const makeHal = () => {
	let now = 0;
	let accelG = 0;

	const imu: ImuSample = {
		accel: { x: 0, y: 0, z: 9.81 },
		gyro: { x: 0, y: 0, z: 0 },
	};

	const hal: INodeHAL = {
		getIMU: () => ({ ...imu, accel: { x: accelG * 9.81, y: 0, z: 9.81 } }),
		pollRadio: () => [],
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
	};
};

describe("State machine & IMU triggers", () => {
	it("MOVING when accel > 0.5G, STATIONARY after 5s quiet", () => {
		const { hal, setAccelG, setNow } = makeHal();
		const fw = new NodeFirmware(1, hal, {
			eventDrivenSensing: true,
			isolationNoAckMs: 100_000,
		});

		// 1) Start stationary.
		setNow(0);
		setAccelG(0.0);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");

		// 2) Trigger moving (0.6G).
		setNow(100);
		setAccelG(0.6);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// 3) Sustain low accel for 4s: still MOVING (hysteresis).
		setAccelG(0.0);
		setNow(1_000);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");

		// 4) After >5s total low accel: back to STATIONARY.
		setNow(6_100);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");
	});

	it("stays STATIONARY at or below the threshold", () => {
		const { hal, setAccelG, setNow } = makeHal();
		const fw = new NodeFirmware(1, hal, {
			eventDrivenSensing: true,
			isolationNoAckMs: 100_000,
		});

		// Exactly 0.5G should NOT trigger MOVING (threshold is strictly > 0.5G).
		setNow(0);
		setAccelG(0.5);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");

		// Below threshold remains STATIONARY.
		setNow(200);
		setAccelG(0.4);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("STATIONARY");
	});
});
