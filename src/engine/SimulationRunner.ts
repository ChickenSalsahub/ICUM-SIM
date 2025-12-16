import { NodeFirmware } from "../firmware/NodeFirmware";
import { INodeHAL, ImuSample, FirmwareSnapshot } from "../firmware/types";
import { Packet, PacketType, Wall } from "../types";

interface NodeWorldState {
	id: number;
	firmware: NodeFirmware;
	x: number;
	y: number;
	vx: number;
	vy: number;
	batteryV: number;
	hasLte: boolean;
	incoming: Packet[];
}

export interface RunnerSnapshot {
	timeMs: number;
	nodes: Array<{
		id: number;
		trueX: number;
		trueY: number;
		batteryV: number;
		firmware: FirmwareSnapshot;
	}>;
}

export interface SimulationOptions {
	uwbRangeMeters?: number;
	uwbNoiseSigma?: number;
	packetLoss?: number; // 0..1
}

export class SimulationRunner {
	private nodes: NodeWorldState[] = [];
	private timeMs = 0;
	private walls: Wall[] = [];
	private readonly uwbRangeMeters: number;
	private readonly uwbNoiseSigma: number;
	private readonly packetLoss: number;

	constructor(opts?: SimulationOptions) {
		this.uwbRangeMeters = opts?.uwbRangeMeters ?? 15;
		this.uwbNoiseSigma = opts?.uwbNoiseSigma ?? 0.05;
		this.packetLoss = opts?.packetLoss ?? 0.1;
	}

	public addWall(w: Wall) {
		this.walls.push(w);
	}

	public addNode(
		id: number,
		pos: { x: number; y: number },
		velocity: { vx: number; vy: number },
		batteryV = 3.7,
		hasLte = false
	) {
		const incoming: Packet[] = [];
		const hal: INodeHAL = {
			getIMU: () => this.syntheticImu(id),
			pollRadio: () => {
				const items = [...incoming];
				incoming.length = 0;
				return items;
			},
			getBatteryVoltage: () => batteryV,
			getTimeMs: () => this.timeMs,
			radioSend: (packet) => this.handleTx(id, packet),
			log: (_msg) => {
				// no-op in headless
			},
		};

		const fw = new NodeFirmware(id, hal, undefined, { lteCapable: hasLte });
		this.nodes.push({
			id,
			firmware: fw,
			x: pos.x,
			y: pos.y,
			vx: velocity.vx,
			vy: velocity.vy,
			batteryV,
			hasLte,
			incoming,
		});
	}

	public step(dtMs: number) {
		this.timeMs += dtMs;

		// Physics integration
		for (const n of this.nodes) {
			n.x += (n.vx * dtMs) / 1000;
			n.y += (n.vy * dtMs) / 1000;
		}

		// Advance firmware
		for (const n of this.nodes) {
			n.firmware.tick(dtMs);
		}
	}

	private syntheticImu(id: number): ImuSample {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) {
			return { accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } };
		}
		const accelMag = Math.sqrt(node.vx * node.vx + node.vy * node.vy) * 0.1;
		return {
			accel: { x: accelMag, y: 0, z: 9.81 },
			gyro: { x: 0, y: 0, z: 0 },
		};
	}

	private handleTx(senderId: number, packet: Packet) {
		for (const target of this.nodes) {
			if (target.id === senderId) continue;
			if (Math.random() < this.packetLoss) continue;

			const dist = this.distance(senderId, target.id);
			if (dist === null || dist > this.uwbRangeMeters) continue;
			if (this.isBlocked(senderId, target.id)) continue;

			const cloned: Packet = { ...packet, destId: packet.destId, srcId: senderId };
			if (cloned.payload?.type === "RANGING_POLL") {
				const measurement = this.uwbMeasure(senderId, target.id);
				cloned.payload.range = measurement.measuredDistanceMeters;
				cloned.payload.angle = measurement.aoa;
			}

			const recipient = this.nodes.find((n) => n.id === target.id);
			if (recipient) {
				(recipient.incoming as Packet[]).push(cloned);
			}
		}
	}

	private distance(aId: number, bId: number): number | null {
		const a = this.nodes.find((n) => n.id === aId);
		const b = this.nodes.find((n) => n.id === bId);
		if (!a || !b) return null;
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return Math.sqrt(dx * dx + dy * dy);
	}

	private uwbMeasure(senderId: number, receiverId: number) {
		const dist = this.distance(senderId, receiverId) ?? Infinity;
		const angle = this.bearing(senderId, receiverId);
		const noisy = Math.max(0, dist + this.gaussian() * this.uwbNoiseSigma);
		return {
			measuredDistanceMeters: noisy,
			aoa: angle,
			aod: angle,
			los: !this.isBlocked(senderId, receiverId),
		};
	}

	private bearing(aId: number, bId: number): number {
		const a = this.nodes.find((n) => n.id === aId);
		const b = this.nodes.find((n) => n.id === bId);
		if (!a || !b) return 0;
		return Math.atan2(b.y - a.y, b.x - a.x);
	}

	private isBlocked(aId: number, bId: number): boolean {
		const a = this.nodes.find((n) => n.id === aId);
		const b = this.nodes.find((n) => n.id === bId);
		if (!a || !b) return false;
		for (const w of this.walls) {
			if (this.doIntersect({ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }))
				return true;
		}
		return false;
	}

	private doIntersect(
		p1: { x: number; y: number },
		q1: { x: number; y: number },
		p2: { x: number; y: number },
		q2: { x: number; y: number }
	) {
		const orientation = (p: any, q: any, r: any) => {
			const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
			if (val === 0) return 0;
			return val > 0 ? 1 : 2;
		};
		const onSegment = (p: any, q: any, r: any) => {
			return (
				q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
			);
		};
		const o1 = orientation(p1, q1, p2);
		const o2 = orientation(p1, q1, q2);
		const o3 = orientation(p2, q2, p1);
		const o4 = orientation(p2, q2, q1);
		if (o1 !== o2 && o3 !== o4) return true;
		if (o1 === 0 && onSegment(p1, p2, q1)) return true;
		if (o2 === 0 && onSegment(p1, q2, q1)) return true;
		if (o3 === 0 && onSegment(p2, p1, q2)) return true;
		if (o4 === 0 && onSegment(p2, q1, q2)) return true;
		return false;
	}

	private gaussian() {
		let u = 0;
		let v = 0;
		while (u === 0) u = Math.random();
		while (v === 0) v = Math.random();
		return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
	}

	public snapshot(): RunnerSnapshot {
		return {
			timeMs: this.timeMs,
			nodes: this.nodes.map((n) => ({
				id: n.id,
				trueX: n.x,
				trueY: n.y,
				batteryV: n.batteryV,
				firmware: n.firmware.getSnapshot(),
			})),
		};
	}

	public runFor(simSeconds: number, dtMs = 50) {
		const steps = Math.ceil((simSeconds * 1000) / dtMs);
		for (let i = 0; i < steps; i++) {
			this.step(dtMs);
		}
		return this.snapshot();
	}
}
