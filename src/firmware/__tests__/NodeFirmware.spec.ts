import { describe, it, expect } from "vitest";
import { NodeFirmware } from "../NodeFirmware";
import { INodeHAL, ImuSample } from "../types";
import { Packet, PacketType } from "../../types";

const makeHal = (opts: { accelG?: number; batteryV?: number; now?: number }) => {
	let radioOut: Packet[] = [];
	const imu: ImuSample = {
		accel: { x: 0, y: 0, z: (opts.accelG ?? 0) * 9.81 },
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
		const { hal } = makeHal({ accelG: 0.6 });
		const fw = new NodeFirmware(1, hal);
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("MOVING");
	});
});

describe("Leader Election", () => {
	it("prefers higher battery when connectivity equal", () => {
		const now = 0;
		const { hal } = makeHal({ accelG: 0.1, batteryV: 3.7, now });
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
});
