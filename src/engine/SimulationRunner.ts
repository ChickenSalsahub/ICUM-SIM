import { Packet, RangingResult, Wall } from "../types";
import { FirmwareConfig, FirmwareSnapshot, INodeHAL } from "../firmware/types";
import { NodeFirmware } from "../firmware/NodeFirmware";
import { UWBRanging } from "../logic/UWBRanging";
import { createMulberry32, RngFn } from "../logic/math/Random";

export interface SimulationHooks {
	onDeliver?: (info: {
		senderId: number;
		recipientId: number;
		packet: Packet;
		range: number;
		senderPos: { x: number; y: number };
		timeMs: number;
		ranging?: RangingResult;
	}) => void;
	onTx?: (info: { timeMs: number; senderId: number; packet: Packet; senderPos: { x: number; y: number } }) => void;
}

export interface SimulationOptions {
	seed?: number;
	uwbRangeMeters?: number;
	uwbNoiseSigma?: number;
	uwbAngleNoiseStdRad?: number;
	packetLoss?: number;
	firmwareConfig?: Partial<FirmwareConfig>;
	worldBounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

interface NodeWorldState {
	id: number;
	firmware: NodeFirmware;
	x: number;
	y: number;
	vx: number;
	vy: number;
	batteryCapacity: number; // 0.0 to 1.0 (Full)
	incoming: Packet[];
	txCount: number;
}

// Energy Model Constants
const ENERGY_COST_TX = 0.0005; // Cost per packet sent (approx 0.05% of battery)
const ENERGY_COST_IDLE_PER_MS = 0.000001; // Base idle cost (approx 0.1% per 100s)
const C_MOVE = 0.000002; // Movement cost per ms when moving
const BATTERY_FULL = 1.0;
const VOLTAGE_MAX = 4.2;
const VOLTAGE_MIN = 3.0;

export class SimulationRunner {
	private nodes: NodeWorldState[] = [];
	private timeMs = 0;
	private walls: Wall[] = [];
	private uwbRangeMeters: number;
	private packetLoss: number;
	private uwb: UWBRanging;
	private readonly rng: RngFn;
	private worldBounds: { minX: number; maxX: number; minY: number; maxY: number } | undefined;
	private hooks: SimulationHooks = {};
	private readonly firmwareConfig: Partial<FirmwareConfig> | undefined;

	constructor(opts?: SimulationOptions) {
		this.rng = opts?.seed ? createMulberry32(opts.seed) : Math.random;
		this.uwbRangeMeters = opts?.uwbRangeMeters ?? 15;
		this.packetLoss = opts?.packetLoss ?? 0;
		this.firmwareConfig = opts?.firmwareConfig;
		this.worldBounds = opts?.worldBounds;
		this.uwb = new UWBRanging(opts?.seed ?? 123, {
			noiseStdMeters: opts?.uwbNoiseSigma,
			angleNoiseStdRad: opts?.uwbAngleNoiseStdRad,
		});
	}

	public setWalls(walls: Wall[]) {
		this.walls = [...walls];
	}

	public addWall(wall: Wall) {
		this.walls.push(wall);
	}

	public setHooks(hooks: SimulationHooks) {
		this.hooks = hooks;
	}

	public setUwbRangeMeters(range: number) {
		this.uwbRangeMeters = Math.max(0, range);
	}

	public setPacketLoss(loss: number) {
		this.packetLoss = Math.max(0, Math.min(1, loss));
	}

	public setUwbNoiseSigma(sigma: number) {
		this.uwb.setNoiseStdMeters(Math.max(0, sigma));
	}

	public setUwbAngleNoiseStdRad(stdRad: number) {
		this.uwb.setAngleNoiseStdRad(Math.max(0, stdRad));
	}

	public getTimeMs() {
		return this.timeMs;
	}

	public addNode(
		id: number,
		pos: { x: number; y: number },
		velocity: { vx: number; vy: number } = { vx: 0, vy: 0 },
		batteryV = 3.7,
		hasLte = false,
		initialRole: any = undefined,
	) {
		// Calculate initial capacity based on requested voltage
		const initialPct = Math.max(0, Math.min(1, (batteryV - VOLTAGE_MIN) / (VOLTAGE_MAX - VOLTAGE_MIN)));

		const nodeState: NodeWorldState = {
			id,
			x: pos.x,
			y: pos.y,
			vx: velocity.vx,
			vy: velocity.vy,
			batteryCapacity: initialPct * BATTERY_FULL,
			incoming: [],
			firmware: null as any,
			txCount: 0,
		};

		const hal: INodeHAL = {
			getIMU: () => this.syntheticImu(id),
			pollRadio: () => {
				const items = [...nodeState.incoming];
				nodeState.incoming.length = 0;
				return items;
			},
			getBatteryVoltage: () => {
				const pct = Math.max(0, nodeState.batteryCapacity / BATTERY_FULL);
				return VOLTAGE_MIN + pct * (VOLTAGE_MAX - VOLTAGE_MIN);
			},
			getTimeMs: () => this.timeMs,
			radioSend: (packet) => this.transmitPacket(id, packet),
			log: (_msg) => {},
			getGlobalPosition: () => this.syntheticGps(nodeState.x, nodeState.y),
		};

		// Correct constructor: (id, hal, config, options)
		const fw = new NodeFirmware(id, hal, this.firmwareConfig, {
			lteCapable: hasLte,
			gpsCapable: this.firmwareConfig?.gpsCapable ?? hasLte,
		});

		// Hack for initialRole if needed/supported by private/any casting
		if (initialRole) {
			(fw as any).role = initialRole;
		}

		nodeState.firmware = fw;
		this.nodes.push(nodeState);
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

	public setNodeBatteryV(id: number, batteryV: number) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		const pct = (batteryV - VOLTAGE_MIN) / (VOLTAGE_MAX - VOLTAGE_MIN);
		node.batteryCapacity = Math.max(0, Math.min(BATTERY_FULL, pct * BATTERY_FULL));
	}

	public getNodeIds(): number[] {
		return this.nodes.map((n) => n.id);
	}

	public runFor(seconds: number) {
		const stepMs = 100;
		const steps = (seconds * 1000) / stepMs;
		for (let i = 0; i < steps; i++) {
			this.step(stepMs);
		}
	}

	public step(dtMs: number) {
		this.timeMs += dtMs;

		const indices = this.nodes.map((_, i) => i);
		for (let i = indices.length - 1; i > 0; i--) {
			const j = Math.floor(this.rng() * (i + 1));
			[indices[i], indices[j]] = [indices[j], indices[i]];
		}

		for (const i of indices) {
			const node = this.nodes[i];

			// Apply Idle Cost
			node.batteryCapacity -= ENERGY_COST_IDLE_PER_MS * dtMs;
			const speed = Math.hypot(node.vx, node.vy);
			if (speed > 1e-6) {
				node.batteryCapacity -= C_MOVE * dtMs;
			}
			if (node.batteryCapacity < 0) node.batteryCapacity = 0;

			if (node.batteryCapacity <= 0) {
				node.vx = 0;
				node.vy = 0;
				continue;
			}

			// Physics
			const prevX = node.x;
			const prevY = node.y;
			const nextX = prevX + (node.vx * dtMs) / 1000;
			const nextY = prevY + (node.vy * dtMs) / 1000;

			if (this.segmentHitsAnyWall(prevX, prevY, nextX, nextY)) {
				node.vx = 0;
				node.vy = 0;
			} else {
				node.x = nextX;
				node.y = nextY;
			}
			this.applyBounds(node);

			node.firmware.tick(dtMs);
		}
	}

	private transmitPacket(senderId: number, packet: Packet) {
		const sender = this.nodes.find((n) => n.id === senderId);
		// Dead check
		if (!sender || sender.batteryCapacity <= 0) return;

		// TX Cost
		sender.batteryCapacity -= ENERGY_COST_TX;
		sender.txCount++;
		if (sender.batteryCapacity <= 0) {
			sender.batteryCapacity = 0;
			return; // Died
		}

		if (this.hooks.onTx) {
			this.hooks.onTx({
				timeMs: this.timeMs,
				senderId: sender.id,
				packet: JSON.parse(JSON.stringify(packet)), // Copy to avoid mutation
				senderPos: { x: sender.x, y: sender.y },
			});
		}

		if (this.packetLoss > 0 && this.rng() < this.packetLoss) return;

		for (const recipient of this.nodes) {
			if (recipient.id === senderId) continue;
			if (recipient.batteryCapacity <= 0) continue;

			// Wall Occlusion
			if (this.segmentHitsAnyWall(sender.x, sender.y, recipient.x, recipient.y)) continue;

			const ranging = this.uwb.measure(
				{ id: sender.id, x: sender.x, y: sender.y },
				{ id: recipient.id, x: recipient.x, y: recipient.y },
				{ pixelsPerMeter: 1, maxRangeMeters: this.uwbRangeMeters, walls: this.walls },
			);

			if (!ranging.success) continue;

			const clone: Packet = JSON.parse(JSON.stringify(packet));
			if (clone.payload && typeof clone.payload === "object") {
				(clone.payload as any).range = ranging.measuredDistanceMeters;
				const angleFromRecipient = Math.atan2(sender.y - recipient.y, sender.x - recipient.x);
				(clone.payload as any).angle = angleFromRecipient;
			}

			recipient.incoming.push(clone);

			if (this.hooks.onDeliver) {
				this.hooks.onDeliver({
					senderId,
					recipientId: recipient.id,
					packet: clone,
					range: ranging.measuredDistanceMeters,
					senderPos: { x: sender.x, y: sender.y },
					timeMs: this.timeMs,
					ranging,
				});
			}
		}
	}

	private syntheticImu(nodeId: number) {
		const node = this.nodes.find((n) => n.id === nodeId);
		if (!node) return { accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 }, mag: { x: 0, y: 0, z: 0 } };

		const isMoving = Math.abs(node.vx) > 0.01 || Math.abs(node.vy) > 0.01;
		if (isMoving) {
			// Ensure linear accel magnitude exceeds 0.5g to trigger MOVING state.
			const angle = this.rng() * Math.PI * 2;
			const linG = 0.6 + this.rng() * 0.2; // 0.6g - 0.8g
			const linAccel = linG * 9.81;
			const ax = Math.cos(angle) * linAccel;
			const ay = Math.sin(angle) * linAccel;
			const az = 9.81 + (this.rng() - 0.5) * 0.2;
			return {
				accel: { x: ax, y: ay, z: az },
				gyro: { x: 0, y: 0, z: 0 },
				mag: { x: 0, y: 0, z: 0 },
			};
		}

		const ax = (this.rng() - 0.5) * 0.05;
		const ay = (this.rng() - 0.5) * 0.05;
		const az = 9.81 + (this.rng() - 0.5) * 0.05;

		return {
			accel: { x: ax, y: ay, z: az },
			gyro: { x: 0, y: 0, z: 0 },
			mag: { x: 0, y: 0, z: 0 },
		};
	}

	private syntheticGps(xMeters: number, yMeters: number) {
		// Very simple GPS mapping: meters -> degrees around an arbitrary origin.
		const metersPerDeg = 111_111;
		const noiseMeters = 5 * (this.rng() - 0.5); // +/-2.5m jitter
		return {
			lat: (yMeters + noiseMeters) / metersPerDeg,
			lng: (xMeters + noiseMeters) / metersPerDeg,
			alt: 0,
		};
	}

	private segmentsIntersect(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		x3: number,
		y3: number,
		x4: number,
		y4: number,
	) {
		const det = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
		if (det === 0) return false;
		const lambda = ((y4 - y3) * (x4 - x1) + (x3 - x4) * (y4 - y1)) / det;
		const gamma = ((y1 - y2) * (x4 - x1) + (x2 - x1) * (y4 - y1)) / det;
		return lambda > 0 && lambda < 1 && gamma > 0 && gamma < 1;
	}

	private segmentHitsAnyWall(ax: number, ay: number, bx: number, by: number): boolean {
		if (this.walls.length === 0) return false;
		for (const w of this.walls) {
			if (this.segmentsIntersect(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) return true;
		}
		return false;
	}

	private applyBounds(node: NodeWorldState) {
		if (!this.worldBounds) return;
		if (node.x < this.worldBounds.minX) {
			node.x = this.worldBounds.minX;
			node.vx = 0;
		}
		if (node.x > this.worldBounds.maxX) {
			node.x = this.worldBounds.maxX;
			node.vx = 0;
		}
		if (node.y < this.worldBounds.minY) {
			node.y = this.worldBounds.minY;
			node.vy = 0;
		}
		if (node.y > this.worldBounds.maxY) {
			node.y = this.worldBounds.maxY;
			node.vy = 0;
		}
	}

	public snapshot(): {
		timeMs: number;
		nodes: {
			id: number;
			x: number;
			y: number;
			trueX: number;
			trueY: number;
			txCount: number;
			firmware: FirmwareSnapshot;
		}[];
	} {
		return {
			timeMs: this.timeMs,
			nodes: this.nodes.map((n) => ({
				id: n.id,
				x: n.x,
				y: n.y,
				trueX: n.x,
				trueY: n.y,
				txCount: n.txCount,
				firmware: n.firmware.getSnapshot(),
			})),
		};
	}
}
