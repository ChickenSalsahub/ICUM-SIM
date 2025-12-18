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

	it("emits a PANIC packet when entering ISOLATED", () => {
		let now = 0;
		const { hal, radioOut } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => [];

		const fw = new NodeFirmware(1, hal, {
			isolationNoAckMs: 1_000,
			neighborTimeoutMs: 100_000,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
		});

		fw.tick(100);
		expect(radioOut.some((p) => p.type === PacketType.PANIC)).toBe(false);

		now = 2_000;
		fw.tick(100);
		expect(fw.getSnapshot().state).toBe("ISOLATED");
		expect(radioOut.some((p) => p.type === PacketType.PANIC)).toBe(true);
	});

	it("immediately ACKs the sender when receiving a PANIC packet", () => {
		let now = 0;
		const { hal, radioOut } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;

		let deliverOnce = true;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			if (!deliverOnce) return [];
			deliverOnce = false;
			return [
				{
					id: "panic-2",
					type: PacketType.PANIC,
					srcId: 2,
					destId: -1,
					payload: { type: "PANIC" },
					timestamp: now,
				},
			];
		};

		const fw = new NodeFirmware(1, hal, {
			isolationNoAckMs: 100_000,
			neighborTimeoutMs: 100_000,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
		});

		fw.tick(100);
		const ack = radioOut.find((p) => p.payload?.type === "ACK" && p.destId === 2);
		expect(ack).toBeTruthy();
	});

	it("forwards UPLINK_GOSSIP to its leader when acting as a relay", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			const items = inbound;
			inbound = [];
			return items;
		};
		(hal.radioSend as unknown as (p: Packet) => void) = (p) => radioOut.push(p);

		const fw = new NodeFirmware(1, hal, {
			isolationNoAckMs: 100_000,
			neighborTimeoutMs: 100_000,
			helloIntervalIdleMs: 1_000_000,
			helloIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
		});

		// Step 1: make node 2 look like a better leader so fw(1) becomes RELAY with leaderId=2.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.2, degree: 5, lteCapable: true },
				timestamp: now,
			},
		];
		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(2);
		expect(fw.getSnapshot().role).toBe("RELAY");

		// Step 2: deliver an uplink gossip from node 3 directly to node 1.
		radioOut = [];
		now = 1_000;
		inbound = [
			{
				id: "gossip-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: 1,
				payload: {
					type: "UPLINK_GOSSIP",
					targetLeaderId: 2,
					ttl: 2,
					report: {
						nodeId: 3,
						timestamp: now,
						batteryV: 3.9,
						status: "STATIONARY",
						lteCapable: false,
						neighbors: [],
					},
				},
				timestamp: now,
			},
		];
		fw.tick(100);

		const forwarded = radioOut.find(
			(p) =>
				p.payload?.type === "UPLINK_GOSSIP" &&
				p.destId === 2 &&
				(p.payload as any)?.targetLeaderId === 2 &&
				(p.payload as any)?.ttl === 1
		);
		expect(forwarded).toBeTruthy();
	});

	it("leader includes forwarded multi-hop UPLINK_GOSSIP report in its next uplink batch", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 4.2, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			const items = inbound;
			inbound = [];
			return items;
		};
		(hal.radioSend as unknown as (p: Packet) => void) = (p) => radioOut.push(p);

		// Node 2 will become leader (higher battery than neighbor) and also act as uplink node.
		const fwLeader = new NodeFirmware(2, hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 0,
			helloIntervalMovingMs: 0,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
			neighborTimeoutMs: 100_000,
		});

		// Provide one neighbor so leader election runs and can self-elect.
		inbound = [
			{
				id: "hello-1",
				type: PacketType.DATA,
				srcId: 1,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, lteCapable: false },
				timestamp: now,
			},
			{
				id: "gossip-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: -1,
				payload: {
					type: "UPLINK_GOSSIP",
					targetLeaderId: 2,
					ttl: 2,
					report: {
						nodeId: 3,
						timestamp: 1234,
						batteryV: 3.9,
						status: "STATIONARY",
						lteCapable: false,
						neighbors: [],
					},
				},
				timestamp: now,
			},
		];

		radioOut = [];
		now = 1_000;
		fwLeader.tick(100);

		const uplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(uplink).toBeTruthy();
		const reports = (uplink as any)?.payload?.reports;
		expect(Array.isArray(reports)).toBe(true);
		expect((reports as any[]).some((r) => r?.nodeId === 3)).toBe(true);
	});

	it("leader includes TOPOLOGY_CHANGE event in UPLINK_BATCH when neighbor set changes", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 3.7, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			const items = inbound;
			inbound = [];
			return items;
		};
		(hal.radioSend as unknown as (p: Packet) => void) = (p) => radioOut.push(p);

		const fw = new NodeFirmware(1, hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 0,
			helloIntervalMovingMs: 0,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
			neighborTimeoutMs: 100_000,
		});

		// First neighbor appears.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, lteCapable: false },
				timestamp: now,
			},
		];
		radioOut = [];
		fw.tick(100);
		const firstUplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(firstUplink).toBeTruthy();
		const firstEvents = (firstUplink as any)?.payload?.events;
		expect(Array.isArray(firstEvents)).toBe(true);
		expect((firstEvents as any[]).some((e) => e?.kind === "TOPOLOGY_CHANGE" && e?.nodeId === 1)).toBe(true);

		// Topology changes again (new neighbor 3).
		now = 1_000;
		inbound = [
			{
				id: "hello-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, lteCapable: false },
				timestamp: now,
			},
		];
		radioOut = [];
		fw.tick(100);
		const secondUplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(secondUplink).toBeTruthy();
		const secondEvents = (secondUplink as any)?.payload?.events;
		expect(Array.isArray(secondEvents)).toBe(true);
		expect((secondEvents as any[]).some((e) => e?.kind === "TOPOLOGY_CHANGE" && e?.nodeId === 1)).toBe(true);
	});

	it("leader emits TOPOLOGY_CHANGE event when a leaf report's topologyVersion increases", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const { hal } = makeHal({ linearAccelG: 0.0, batteryV: 4.2, now });
		(hal.getTimeMs as unknown as () => number) = () => now;
		(hal.pollRadio as unknown as () => Packet[]) = () => {
			const items = inbound;
			inbound = [];
			return items;
		};
		(hal.radioSend as unknown as (p: Packet) => void) = (p) => radioOut.push(p);

		// Node 2 will become leader and uplink node.
		const fwLeader = new NodeFirmware(2, hal, {
			eventDrivenSensing: false,
			helloIntervalIdleMs: 0,
			helloIntervalMovingMs: 0,
			rangingIntervalIdleMs: 1_000_000,
			rangingIntervalMovingMs: 1_000_000,
			isolationNoAckMs: 100_000,
			neighborTimeoutMs: 100_000,
		});

		// Provide one neighbor so leader election runs.
		inbound = [
			{
				id: "hello-1",
				type: PacketType.DATA,
				srcId: 1,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, lteCapable: false },
				timestamp: now,
			},
			{
				id: "gossip-3-v1",
				type: PacketType.DATA,
				srcId: 3,
				destId: 2,
				payload: {
					type: "UPLINK_GOSSIP",
					targetLeaderId: 2,
					ttl: 2,
					report: {
						nodeId: 3,
						timestamp: 500,
						batteryV: 3.9,
						status: "STATIONARY",
						lteCapable: false,
						neighbors: [],
						degree: 1,
						topologyVersion: 1,
					},
				},
				timestamp: now,
			},
		];
		radioOut = [];
		now = 1_000;
		fwLeader.tick(100);
		let uplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(uplink).toBeTruthy();
		let events = (uplink as any)?.payload?.events;
		expect(Array.isArray(events)).toBe(true);
		expect((events as any[]).some((e) => e?.kind === "TOPOLOGY_CHANGE" && e?.nodeId === 3)).toBe(true);

		// Send another report from node 3 with higher topologyVersion.
		inbound = [
			{
				id: "gossip-3-v2",
				type: PacketType.DATA,
				srcId: 3,
				destId: 2,
				payload: {
					type: "UPLINK_GOSSIP",
					targetLeaderId: 2,
					ttl: 2,
					report: {
						nodeId: 3,
						timestamp: 1500,
						batteryV: 3.9,
						status: "STATIONARY",
						lteCapable: false,
						neighbors: [],
						degree: 2,
						topologyVersion: 2,
					},
				},
				timestamp: 1_500,
			},
		];
		radioOut = [];
		now = 2_000;
		fwLeader.tick(100);
		uplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(uplink).toBeTruthy();
		events = (uplink as any)?.payload?.events;
		expect(Array.isArray(events)).toBe(true);
		expect((events as any[]).some((e) => e?.kind === "TOPOLOGY_CHANGE" && e?.nodeId === 3)).toBe(true);
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
