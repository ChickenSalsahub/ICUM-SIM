import { describe, it, expect } from "vitest";
import { NodeFirmware } from "../NodeFirmware";
import { INodeHAL, ImuSample } from "../types";
import { Packet, PacketType } from "../../types";

// Tests firmware FSM transitions, leader election, uplink/gossip behavior, and sensing cadence.

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
		getGlobalPosition: () => null,
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
					payload: { type: "HELLO", batteryV: 4.0, degree: 1, hasBackhaul: false },
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

	it("forwards BLE_MESH_REPORT to its leader when acting as a relay", () => {
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
				payload: { type: "HELLO", batteryV: 4.2, degree: 5, hasBackhaul: true },
				timestamp: now,
			},
		];
		fw.tick(100);
		expect(fw.getSnapshot().leaderId).toBe(2);
		expect(fw.getSnapshot().role).toBe("RELAY");

		// Step 2: deliver a mesh report from node 3 directly to node 1.
		radioOut = [];
		now = 1_000;
		inbound = [
			{
				id: "gossip-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: 1,
				payload: {
					type: "BLE_MESH_REPORT",
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
				p.payload?.type === "BLE_MESH_REPORT" &&
				p.destId === 2 &&
				(p.payload as any)?.targetLeaderId === 2 &&
				(p.payload as any)?.ttl === 1,
		);
		expect(forwarded).toBeTruthy();
	});

	it("leader includes forwarded BLE_MESH_REPORT in its next uplink batch", () => {
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
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, hasBackhaul: false },
				timestamp: now,
			},
		];
		fwLeader.tick(100);

		// Deliver a mesh report after leader election has resolved.
		now = 1_000;
		inbound = [
			{
				id: "mesh-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: -1,
				payload: {
					type: "BLE_MESH_REPORT",
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
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, hasBackhaul: false },
				timestamp: now,
			},
		];
		radioOut = [];
		fw.tick(100);
		// Trigger uplink via a mesh report.
		inbound = [
			{
				id: "mesh-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: 1,
				payload: {
					type: "BLE_MESH_REPORT",
					targetLeaderId: 1,
					ttl: 2,
					report: {
						nodeId: 2,
						timestamp: now,
						batteryV: 3.6,
						status: "STATIONARY",
						neighbors: [],
						degree: 1,
						topologyVersion: 1,
					},
				},
				timestamp: now,
			},
		];
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
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, hasBackhaul: false },
				timestamp: now,
			},
		];
		radioOut = [];
		fw.tick(100);
		inbound = [
			{
				id: "mesh-3",
				type: PacketType.DATA,
				srcId: 3,
				destId: 1,
				payload: {
					type: "BLE_MESH_REPORT",
					targetLeaderId: 1,
					ttl: 2,
					report: {
						nodeId: 3,
						timestamp: now,
						batteryV: 3.6,
						status: "STATIONARY",
						neighbors: [],
						degree: 1,
						topologyVersion: 1,
					},
				},
				timestamp: now,
			},
		];
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
				payload: { type: "HELLO", batteryV: 3.6, degree: 1, hasBackhaul: false },
				timestamp: now,
			},
		];
		fwLeader.tick(100);

		// Deliver initial mesh report after leader election.
		inbound = [
			{
				id: "mesh-3-v1",
				type: PacketType.DATA,
				srcId: 3,
				destId: 2,
				payload: {
					type: "BLE_MESH_REPORT",
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
				id: "mesh-3-v2",
				type: PacketType.DATA,
				srcId: 3,
				destId: 2,
				payload: {
					type: "BLE_MESH_REPORT",
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

	it("converges to a single leader in a static cluster", () => {
		let now = 0;
		const makeNode = (id: number, batteryV: number) => {
			let inbound: Packet[] = [];
			const { hal } = makeHal({ linearAccelG: 0.0, batteryV, now });
			(hal.getTimeMs as unknown as () => number) = () => now;
			(hal.pollRadio as unknown as () => Packet[]) = () => {
				const items = inbound;
				inbound = [];
				return items;
			};
			const fw = new NodeFirmware(id, hal, { isolationNoAckMs: 100_000, neighborTimeoutMs: 100_000 });
			return { fw, enqueue: (p: Packet) => inbound.push(p) };
		};

		const n1 = makeNode(1, 3.6);
		const n2 = makeNode(2, 3.8);
		const n3 = makeNode(3, 3.5);

		const makeHello = (srcId: number, batteryV: number): Packet => ({
			id: `hello-${srcId}-${now}`,
			type: PacketType.DATA,
			srcId,
			destId: -1,
			payload: {
				type: "HELLO",
				batteryV,
				degree: 2,
				hasBackhaul: false,
				leaderId: srcId,
				leaderVector: { hasBackhaul: false, degree: 2, batteryV, id: srcId, moving: false },
				status: "STATIONARY",
			},
			timestamp: now,
		});

		// Fully connect the cluster.
		const p1 = makeHello(1, 3.6);
		const p2 = makeHello(2, 3.8);
		const p3 = makeHello(3, 3.5);
		n1.enqueue(p2);
		n1.enqueue(p3);
		n2.enqueue(p1);
		n2.enqueue(p3);
		n3.enqueue(p1);
		n3.enqueue(p2);

		n1.fw.tick(100);
		n2.fw.tick(100);
		n3.fw.tick(100);

		expect(n1.fw.getSnapshot().leaderId).toBe(2);
		expect(n2.fw.getSnapshot().leaderId).toBe(2);
		expect(n3.fw.getSnapshot().leaderId).toBe(2);
		expect(n2.fw.getSnapshot().role).toBe("LEADER");
		expect(n1.fw.getSnapshot().role).toBe("RELAY");
		expect(n3.fw.getSnapshot().role).toBe("RELAY");
	});

	it("prefers LTE-capable neighbor even with lower battery", () => {
		const now = 0;
		const { hal } = makeHal({ linearAccelG: 0.1, batteryV: 4.2, now });
		const fw = new NodeFirmware(1, hal);
		// inject neighbor via fake radio packet
		(hal.pollRadio as unknown as () => Packet[]) = () => [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.4, degree: 1, hasBackhaul: true },
				timestamp: now,
			},
		];
		fw.tick(100);
		const snap = fw.getSnapshot();
		expect(snap.leaderId).toBe(2);
	});

	it("prefers higher battery when LTE status equal", () => {
		const now = 0;
		const { hal } = makeHal({ linearAccelG: 0.1, batteryV: 3.7, now });
		const fw = new NodeFirmware(1, hal);
		(hal.pollRadio as unknown as () => Packet[]) = () => [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 4.0, degree: 1, hasBackhaul: false },
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
					payload: { type: "HELLO", batteryV: 4.0, degree: 1, hasBackhaul: false },
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

	it("does not forward mesh reports while MOVING", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => ({ accel: { x: 0.6 * 9.81, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
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

		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000, neighborTimeoutMs: 100_000 });
		fw.tick(100); // enter MOVING
		inbound = [
			{
				id: "mesh-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: 1,
				payload: {
					type: "BLE_MESH_REPORT",
					targetLeaderId: 3,
					ttl: 2,
					report: {
						nodeId: 2,
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
		radioOut = [];
		now = 1_000;
		fw.tick(100);
		const forwarded = radioOut.find((p) => p.payload?.type === "BLE_MESH_REPORT");
		expect(forwarded).toBeFalsy();
	});
});

describe("DODAG uplink behavior", () => {
	it("non-leader sends mesh report toward leader while MOVING", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => ({ accel: { x: 0.6 * 9.81, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
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

		const fw = new NodeFirmware(1, hal, {
			eventDrivenSensing: false,
			helloIntervalMovingMs: 0,
			helloIntervalIdleMs: 0,
			rangingIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			neighborTimeoutMs: 100_000,
			isolationNoAckMs: 100_000,
		});

		// Introduce an LTE-capable leader neighbor.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: {
					type: "HELLO",
					batteryV: 3.4,
					degree: 2,
					hasBackhaul: true,
					leaderId: 2,
					leaderVector: { hasBackhaul: true, degree: 2, batteryV: 3.4, id: 2, moving: false },
				},
				timestamp: now,
			},
		];
		fw.tick(100);

		// MOVING node should forward its report toward leader via next hop after BLE_ACK.
		radioOut = [];
		now = 1_000;
		inbound = [
			{
				id: "ack-2",
				type: PacketType.BLE_ACK,
				srcId: 2,
				destId: 1,
				payload: { type: "BLE_ACK" },
				timestamp: now,
			},
		];
		fw.tick(100);
		const report = radioOut.find(
			(p) => p.payload?.type === "BLE_MESH_REPORT" && p.destId === 2 && (p.payload as any)?.targetLeaderId === 2,
		);
		expect(report).toBeTruthy();
	});

	it("leader emits UPLINK_BATCH when active and has neighbors", () => {
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

		const fwLeader = new NodeFirmware(1, hal, {
			eventDrivenSensing: false,
			helloIntervalMovingMs: 0,
			helloIntervalIdleMs: 0,
			rangingIntervalMovingMs: 1_000_000,
			rangingIntervalIdleMs: 1_000_000,
			neighborTimeoutMs: 100_000,
			isolationNoAckMs: 100_000,
		});

		// Neighbor has lower score; node 1 should self-elect as leader.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: { type: "HELLO", batteryV: 3.4, degree: 1, hasBackhaul: false },
				timestamp: now,
			},
		];
		radioOut = [];
		fwLeader.tick(100);

		// Trigger the leader to emit an uplink via BLE_ACK.
		now = 1_000;
		inbound = [
			{
				id: "ack-2",
				type: PacketType.BLE_ACK,
				srcId: 2,
				destId: 1,
				payload: { type: "BLE_ACK" },
				timestamp: now,
			},
		];
		radioOut = [];
		fwLeader.tick(100);

		const uplink = radioOut.find((p) => p.type === PacketType.UPLINK);
		expect(uplink).toBeTruthy();
		const reports = (uplink as any)?.payload?.reports;
		expect(Array.isArray(reports)).toBe(true);
		expect((reports as any[]).some((r) => r?.nodeId === 1)).toBe(true);
	});
});

describe("Adaptive sensing cadence", () => {
	it("does not emit UWB_BLINK when stationary", () => {
		const prevRandom = Math.random;
		Math.random = () => 0;
		try {
			let now = 0;
			let radioOut: Packet[] = [];
			const hal: INodeHAL = {
				getIMU: () => ({ accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
				pollRadio: () => [],
				getBatteryVoltage: () => 3.7,
				getTimeMs: () => now,
				getGlobalPosition: () => null,
				radioSend: (p) => radioOut.push(p),
				log: () => {},
			};

			const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000 });
			fw.tick(100);
			expect(radioOut.some((p) => p.type === PacketType.UWB_BLINK)).toBe(false);

			now = 10_000;
			radioOut = [];
			fw.tick(9_900);
			expect(radioOut.some((p) => p.type === PacketType.UWB_BLINK)).toBe(false);
		} finally {
			Math.random = prevRandom;
		}
	});

	it("emits UWB_BLINK at 1Hz when moving", () => {
		const prevRandom = Math.random;
		Math.random = () => 0;
		try {
			let now = 0;
			let radioOut: Packet[] = [];
			const hal: INodeHAL = {
				getIMU: () => ({ accel: { x: 0.6 * 9.81, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
				pollRadio: () => [],
				getBatteryVoltage: () => 3.7,
				getTimeMs: () => now,
				getGlobalPosition: () => null,
				radioSend: (p) => radioOut.push(p),
				log: () => {},
			};

			const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000 });
			fw.tick(100);
			expect(radioOut.some((p) => p.type === PacketType.UWB_BLINK)).toBe(false);

			now = 1_000;
			radioOut = [];
			fw.tick(1_000);
			expect(radioOut.some((p) => p.type === PacketType.UWB_BLINK)).toBe(true);
		} finally {
			Math.random = prevRandom;
		}
	});

	it("responds with BLE_ACK to UWB_BLINK and emits BLE_MESH_REPORT when moving", () => {
		let now = 0;
		let inbound: Packet[] = [];
		let radioOut: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => ({ accel: { x: 0.6 * 9.81, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } }),
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

		const fw = new NodeFirmware(1, hal, { isolationNoAckMs: 100_000, neighborTimeoutMs: 100_000 });

		// Provide a leader neighbor to establish next hop.
		inbound = [
			{
				id: "hello-2",
				type: PacketType.DATA,
				srcId: 2,
				destId: -1,
				payload: {
					type: "HELLO",
					batteryV: 4.0,
					degree: 2,
					hasBackhaul: true,
					leaderId: 2,
					leaderVector: { hasBackhaul: true, degree: 2, batteryV: 4.0, id: 2, moving: false },
				},
				timestamp: now,
			},
		];
		fw.tick(100);

		// Receive UWB_BLINK -> should reply BLE_ACK.
		radioOut = [];
		now = 1_000;
		inbound = [
			{
				id: "blink-2",
				type: PacketType.UWB_BLINK,
				srcId: 2,
				destId: -1,
				payload: { type: "UWB_BLINK", range: 5, angle: 0.1 },
				timestamp: now,
			},
		];
		fw.tick(100);
		const ack = radioOut.find((p) => p.type === PacketType.BLE_ACK);
		expect(ack).toBeTruthy();

		// Receive BLE_ACK while moving -> should emit BLE_MESH_REPORT.
		radioOut = [];
		now = 2_000;
		inbound = [
			{
				id: "ack-2",
				type: PacketType.BLE_ACK,
				srcId: 2,
				destId: 1,
				payload: { type: "BLE_ACK", range: 5, angle: 0.1 },
				timestamp: now,
			},
		];
		fw.tick(100);
		const meshReport = radioOut.find((p) => p.payload?.type === "BLE_MESH_REPORT");
		expect(meshReport).toBeTruthy();
	});
});
