import { NodeFirmware } from "../firmware/NodeFirmware.ts";
import { INodeHAL, ImuSample, FirmwareSnapshot } from "../firmware/types.ts";
import type { FirmwareConfig } from "../firmware/types.ts";
import { Packet, Wall } from "../types/index.ts";
import UWBRanging from "../logic/UWBRanging.ts";
import { createMulberry32, type RngFn } from "../logic/math/Random.ts";

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
	firmwareConfig?: Partial<FirmwareConfig>;
	seed?: number;
	rng?: RngFn;
	worldBounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface SimulationHooks {
	onTx?: (evt: { timeMs: number; senderId: number; packet: Packet; senderPos: { x: number; y: number } }) => void;
	onDeliver?: (evt: {
		timeMs: number;
		senderId: number;
		recipientId: number;
		packet: Packet;
		senderPos: { x: number; y: number };
		recipientPos: { x: number; y: number };
		ranging?: {
			trueDistanceMeters: number;
			measuredDistanceMeters: number;
			aoa?: number;
			aod?: number;
			los: boolean;
		};
	}) => void;
}

export class SimulationRunner {
	private nodes: NodeWorldState[] = [];
	private timeMs = 0;
	private walls: Wall[] = [];
	private uwbRangeMeters: number;
	private packetLoss: number;
	private readonly uwb: UWBRanging;
	private readonly rng: RngFn;
	private worldBounds: { minX: number; maxX: number; minY: number; maxY: number } | undefined;
	private hooks: SimulationHooks | undefined;
	private readonly firmwareConfig: Partial<FirmwareConfig> | undefined;

	constructor(opts?: SimulationOptions) {
		this.rng = opts?.rng ?? (opts?.seed !== undefined ? createMulberry32(opts.seed) : Math.random);
		this.uwbRangeMeters = opts?.uwbRangeMeters ?? 15;
		this.packetLoss = opts?.packetLoss ?? 0.1;
		this.firmwareConfig = opts?.firmwareConfig;
		this.worldBounds = opts?.worldBounds;
		// Share the same stochastic UWB model as the UI.
		// Engine units are meters, so treat them as "pixels" with pixelsPerMeter=1.
		this.uwb = new UWBRanging(1, { rng: this.rng, noiseStdMeters: opts?.uwbNoiseSigma ?? 0.05 });
	}

	public setWorldBounds(bounds: { minX: number; maxX: number; minY: number; maxY: number } | undefined) {
		this.worldBounds = bounds;
	}

	public setHooks(hooks: SimulationHooks | undefined) {
		this.hooks = hooks;
	}

	public setUwbRangeMeters(rangeMeters: number) {
		this.uwbRangeMeters = rangeMeters;
	}

	public setPacketLoss(packetLoss: number) {
		this.packetLoss = packetLoss;
	}

	public setWalls(walls: Wall[]) {
		this.walls = [...walls];
	}

	public addWall(wall: Wall) {
		this.walls.push(wall);
	}

	public addNode(
		id: number,
		pos: { x: number; y: number },
		velocity: { vx: number; vy: number },
		batteryV = 3.7,
		hasLte = false
	) {
		const incoming: Packet[] = [];
		let nodeState: NodeWorldState;
		const hal: INodeHAL = {
			getIMU: () => this.syntheticImu(id),
			pollRadio: () => {
				const items = [...incoming];
				incoming.length = 0;
				return items;
			},
			getBatteryVoltage: () => nodeState.batteryV,
			getTimeMs: () => this.timeMs,
			radioSend: (packet) => this.handleTx(id, packet),
			log: (_msg) => {
				// no-op in headless
			},
		};

		const fw = new NodeFirmware(id, hal, this.firmwareConfig, { lteCapable: hasLte });
		nodeState = {
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
		};
		this.nodes.push(nodeState);
	}

	public setNodeBatteryV(id: number, batteryV: number) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		node.batteryV = batteryV;
	}

	public setNodePose(id: number, pos: { x: number; y: number }) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		node.x = pos.x;
		node.y = pos.y;
	}

	public setNodeVelocity(id: number, velocity: { vx: number; vy: number }) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		node.vx = velocity.vx;
		node.vy = velocity.vy;
	}

	public getNodeIds(): number[] {
		return this.nodes.map((n) => n.id);
	}

	public step(dtMs: number) {
		this.timeMs += dtMs;

		for (const node of this.nodes) {
			const prevX = node.x;
			const prevY = node.y;
			const nextX = prevX + (node.vx * dtMs) / 1000;
			const nextY = prevY + (node.vy * dtMs) / 1000;

			if (this.segmentHitsAnyWall(prevX, prevY, nextX, nextY)) {
				// Simple collision response: stop at the wall and zero velocity.
				node.vx = 0;
				node.vy = 0;
				// Keep position unchanged.
			} else {
				node.x = nextX;
				node.y = nextY;
			}
			this.applyBounds(node);
		}

		for (const node of this.nodes) {
			node.firmware.tick(dtMs);
		}
	}

	private segmentHitsAnyWall(ax: number, ay: number, bx: number, by: number): boolean {
		if (this.walls.length === 0) return false;
		for (const w of this.walls) {
			if (this.segmentsIntersect(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) return true;
		}
		return false;
	}

	private segmentsIntersect(
		ax: number,
		ay: number,
		bx: number,
		by: number,
		cx: number,
		cy: number,
		dx: number,
		dy: number
	): boolean {
		const eps = 1e-12;
		const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
			(qx - px) * (ry - py) - (qy - py) * (rx - px);
		const onSegment = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
			rx <= Math.max(px, qx) + eps &&
			rx >= Math.min(px, qx) - eps &&
			ry <= Math.max(py, qy) + eps &&
			ry >= Math.min(py, qy) - eps;

		const o1 = orient(ax, ay, bx, by, cx, cy);
		const o2 = orient(ax, ay, bx, by, dx, dy);
		const o3 = orient(cx, cy, dx, dy, ax, ay);
		const o4 = orient(cx, cy, dx, dy, bx, by);

		// General case
		if ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) {
			if ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps)) return true;
		}

		// Colinear / touching cases
		if (Math.abs(o1) <= eps && onSegment(ax, ay, bx, by, cx, cy)) return true;
		if (Math.abs(o2) <= eps && onSegment(ax, ay, bx, by, dx, dy)) return true;
		if (Math.abs(o3) <= eps && onSegment(cx, cy, dx, dy, ax, ay)) return true;
		if (Math.abs(o4) <= eps && onSegment(cx, cy, dx, dy, bx, by)) return true;
		return false;
	}

	private applyBounds(node: NodeWorldState) {
		const b = this.worldBounds;
		if (!b) return;

		if (node.x < b.minX) {
			node.x = b.minX;
			if (node.vx < 0) node.vx = 0;
		} else if (node.x > b.maxX) {
			node.x = b.maxX;
			if (node.vx > 0) node.vx = 0;
		}

		if (node.y < b.minY) {
			node.y = b.minY;
			if (node.vy < 0) node.vy = 0;
		} else if (node.y > b.maxY) {
			node.y = b.maxY;
			if (node.vy > 0) node.vy = 0;
		}
	}

	private syntheticImu(id: number): ImuSample {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) {
			return { accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } };
		}
		// Provide a synthetic *linear* acceleration cue for motion detection.
		// Firmware subtracts gravity internally, so we embed gravity in z and add a bump in x when moving.
		const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
		const linAx = speed > 0.05 ? 6.0 : 0.0; // m/s^2 (~0.61g) when moving
		return {
			accel: { x: linAx, y: 0, z: 9.81 },
			gyro: { x: 0, y: 0, z: 0 },
		};
	}

	private handleTx(senderId: number, packet: Packet) {
		const sender = this.nodes.find((n) => n.id === senderId);
		if (!sender) return;
		sender.txCount += 1;

		this.hooks?.onTx?.({
			timeMs: this.timeMs,
			senderId,
			packet,
			senderPos: { x: sender.x, y: sender.y },
		});

		for (const recipient of this.nodes) {
			if (recipient.id === senderId) continue;
			if (packet.destId !== -1 && packet.destId !== recipient.id) continue;
			if (this.rng() < this.packetLoss) continue;

			const ranging = this.uwb.measure(
				{ id: sender.id, x: sender.x, y: sender.y },
				{ id: recipient.id, x: recipient.x, y: recipient.y },
				{ pixelsPerMeter: 1, maxRangeMeters: this.uwbRangeMeters, walls: this.walls }
			);
			if (!ranging.success) continue;

			// IMPORTANT: clone payload per-recipient so UWB range/angle injection doesn't
			// overwrite other recipients' measurements for broadcast packets.
			const cloned: Packet = {
				...packet,
				srcId: senderId,
				payload: packet.payload && typeof packet.payload === "object" ? { ...packet.payload } : packet.payload,
			};
			if (
				cloned.payload?.type === "RANGING_POLL" ||
				cloned.payload?.type === "RANGING_RESP" ||
				cloned.payload?.type === "HELLO"
			) {
				const normalizeAngleRad = (a: number) => {
					let x = a;
					while (x > Math.PI) x -= 2 * Math.PI;
					while (x < -Math.PI) x += 2 * Math.PI;
					return x;
				};
				// UWBRanging returns bearing from sender -> receiver.
				// Firmware expects bearing from *self(receiver)* -> neighbor(sender), so flip by π.
				const angleSelfToNeighbor = normalizeAngleRad((ranging.aoa ?? 0) + Math.PI);
				cloned.payload.range = ranging.measuredDistanceMeters;
				cloned.payload.angle = angleSelfToNeighbor;
			}

			recipient.incoming.push(cloned);
			this.hooks?.onDeliver?.({
				timeMs: this.timeMs,
				senderId,
				recipientId: recipient.id,
				packet: cloned,
				senderPos: { x: sender.x, y: sender.y },
				recipientPos: { x: recipient.x, y: recipient.y },
				ranging: {
					trueDistanceMeters: ranging.trueDistanceMeters,
					measuredDistanceMeters: ranging.measuredDistanceMeters,
					aoa: ranging.aoa,
					aod: ranging.aod,
					los: ranging.los,
				},
			});
		}
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
