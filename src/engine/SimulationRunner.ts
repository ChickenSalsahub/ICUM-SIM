import { NodeFirmware } from "../firmware/NodeFirmware.ts";
import { INodeHAL, ImuSample, FirmwareSnapshot } from "../firmware/types.ts";
import { Packet, Wall } from "../types/index.ts";
import UWBRanging from "../logic/UWBRanging.ts";

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
	private hooks: SimulationHooks | undefined;

	constructor(opts?: SimulationOptions) {
		this.uwbRangeMeters = opts?.uwbRangeMeters ?? 15;
		this.packetLoss = opts?.packetLoss ?? 0.1;
		// Share the same stochastic UWB model as the UI.
		// Engine units are meters, so treat them as "pixels" with pixelsPerMeter=1.
		this.uwb = new UWBRanging(1, { noiseStdMeters: opts?.uwbNoiseSigma ?? 0.05 });
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

		const fw = new NodeFirmware(id, hal, undefined, { lteCapable: hasLte });
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
			node.x += (node.vx * dtMs) / 1000;
			node.y += (node.vy * dtMs) / 1000;
		}

		for (const node of this.nodes) {
			node.firmware.tick(dtMs);
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
			if (Math.random() < this.packetLoss) continue;

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
