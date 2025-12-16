import { NodeFirmware } from "../firmware/NodeFirmware.ts";
import { INodeHAL, ImuSample, FirmwareSnapshot } from "../firmware/types.ts";
import { Packet, Wall } from "../types/index.ts";

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
	txCount: number;
}

export interface RunnerSnapshot {
	timeMs: number;
	nodes: Array<{
		id: number;
		trueX: number;
		trueY: number;
		batteryV: number;
		firmware: FirmwareSnapshot;
		txCount: number;
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
		this.uwbNoiseSigma = opts?.uwbNoiseSigma ?? 0.0;
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
			txCount: 0,
		});
	}

	public step(dtMs: number) {
		this.timeMs += dtMs;

		// Physics integration
		for (const node of this.nodes) {
			node.x += (node.vx * dtMs) / 1000;
			node.y += (node.vy * dtMs) / 1000;
		}

		// Advance firmware
		for (const node of this.nodes) {
			node.firmware.tick(dtMs);
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

	// Handle transmission from one node to all others
	private handleTx(senderId: number, packet: Packet) {
		const sender = this.nodes.find((node) => node.id === senderId);
		if (sender) sender.txCount += 1;

		for (const recipient of this.nodes) {
			if (recipient.id === senderId) continue;
			if (Math.random() < this.packetLoss) continue;

			const distanceMeters = this.distance(senderId, recipient.id);
			if (distanceMeters === null || distanceMeters > this.uwbRangeMeters) continue;
			if (this.isBlocked(senderId, recipient.id)) continue;

			const cloned: Packet = { ...packet, destId: packet.destId, srcId: senderId };
			if (cloned.payload?.type === "RANGING_POLL") {
				const measurement = this.uwbMeasure(senderId, recipient.id);
				cloned.payload.range = measurement.measuredDistanceMeters;
				cloned.payload.angle = measurement.aoa;
			}

			const destination = this.nodes.find((node) => node.id === recipient.id);
			if (destination) {
				(destination.incoming as Packet[]).push(cloned);
			}
		}
	}

	private distance(sourceId: number, targetId: number): number | null {
		const source = this.nodes.find((node) => node.id === sourceId);
		const target = this.nodes.find((node) => node.id === targetId);
		if (!source || !target) return null;
		const dx = source.x - target.x;
		const dy = source.y - target.y;
		return Math.sqrt(dx * dx + dy * dy);
	}

	private uwbMeasure(senderId: number, receiverId: number) {
		const trueDistanceMeters = this.distance(senderId, receiverId) ?? Infinity;
		const angle = this.bearing(senderId, receiverId);
		const noisyDistanceMeters = Math.max(0, trueDistanceMeters + this.gaussian() * this.uwbNoiseSigma);
		return {
			measuredDistanceMeters: noisyDistanceMeters,
			aoa: angle,
			aod: angle,
			los: !this.isBlocked(senderId, receiverId),
		};
	}

	private bearing(sourceId: number, targetId: number): number {
		const source = this.nodes.find((node) => node.id === sourceId);
		const target = this.nodes.find((node) => node.id === targetId);
		if (!source || !target) return 0;
		return Math.atan2(target.y - source.y, target.x - source.x);
	}

	private isBlocked(sourceId: number, targetId: number): boolean {
		const source = this.nodes.find((node) => node.id === sourceId);
		const target = this.nodes.find((node) => node.id === targetId);
		if (!source || !target) return false;
		for (const wall of this.walls) {
			if (
				this.doIntersect(
					{ x: source.x, y: source.y },
					{ x: target.x, y: target.y },
					{ x: wall.x1, y: wall.y1 },
					{ x: wall.x2, y: wall.y2 }
				)
			)
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
			nodes: this.nodes.map((node) => ({
				id: node.id,
				trueX: node.x,
				trueY: node.y,
				batteryV: node.batteryV,
				firmware: node.firmware.getSnapshot(),
				txCount: node.txCount,
			})),
		};
	}

	public runFor(simSeconds: number, dtMs = 50) {
		const steps = Math.ceil((simSeconds * 1000) / dtMs);
		for (let stepIndex = 0; stepIndex < steps; stepIndex++) {
			this.step(dtMs);
		}
		return this.snapshot();
	}
}
