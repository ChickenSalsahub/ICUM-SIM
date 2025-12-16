import { NodeRole, Packet, PacketType } from "../types";
import { FirmwareConfig, FirmwareSnapshot, INodeHAL, NeighborObservation, NodePoseEstimate } from "./types";

interface NeighborState extends NeighborObservation {
	lastSeenMs: number;
	batteryV?: number;
	degree?: number;
	lteCapable?: boolean;
}

interface LeaderScoreInput {
	lteCapable: boolean;
	degree: number;
	batteryV: number;
	id: number;
}

export class NodeFirmware {
	private readonly hal: INodeHAL;
	private readonly cfg: FirmwareConfig;
	private readonly id: number;

	private role: NodeRole = NodeRole.IDLE;
	private state: "STATIONARY" | "MOVING" | "ISOLATED" = "STATIONARY";
	private est: NodePoseEstimate = { x: 0, y: 0 };
	private neighbors: Map<number, NeighborState> = new Map();
	private lastAckMs = 0;
	private lteCapable: boolean;
	private hopsToGw = Number.POSITIVE_INFINITY;
	private leaderId: number | null = null;

	constructor(id: number, hal: INodeHAL, cfg?: Partial<FirmwareConfig>, opts?: { lteCapable?: boolean }) {
		this.id = id;
		this.hal = hal;
		this.cfg = {
			accelMoveThresholdG: 0.5,
			isolationNoAckMs: 30_000,
			lambdaDistance: 1.0,
			lambdaAngle: 0.5,
			learningRate: 0.05,
			...cfg,
		};
		this.lteCapable = opts?.lteCapable ?? false;
	}

	public tick(dtMs: number) {
		const now = this.hal.getTimeMs();
		this.consumeRadio(now);
		this.updateStateFromImu(now);
		this.runLeaderElection(now);
		this.runGraphOptimization(dtMs);
	}

	private consumeRadio(now: number) {
		const packets = this.hal.pollRadio();
		for (const p of packets) {
			if (p.destId !== -1 && p.destId !== this.id) continue;
			if (p.type === PacketType.DATA && p.payload?.type === "HELLO") {
				const obs: NeighborState = {
					id: p.srcId,
					rangeMeters: p.payload.range ?? p.payload.rangeMeters ?? 0,
					angleRad: p.payload.angle,
					timestamp: now,
					lastSeenMs: now,
					batteryV: p.payload.batteryV,
					degree: p.payload.degree,
					lteCapable: p.payload.lteCapable,
				};
				this.neighbors.set(p.srcId, obs);
			}
			if (p.payload?.type === "ACK") {
				this.lastAckMs = now;
			}
		}
	}

	private updateStateFromImu(now: number) {
		const imu = this.hal.getIMU();
		const accelMag = Math.sqrt(imu.accel.x ** 2 + imu.accel.y ** 2 + imu.accel.z ** 2);
		const accelG = accelMag / 9.81;

		const isMoving = accelG > this.cfg.accelMoveThresholdG;
		if (isMoving) {
			this.state = "MOVING";
		} else if (this.state === "MOVING") {
			this.state = "STATIONARY";
		}

		if (this.state === "MOVING" && now - this.lastAckMs > this.cfg.isolationNoAckMs) {
			this.state = "ISOLATED";
		}
	}

	private runLeaderElection(now: number) {
		const degree = this.neighbors.size;
		const score = (input: LeaderScoreInput) => {
			return (
				(input.lteCapable ? 1 : 0) * 1_000_000 + input.degree * 10_000 + input.batteryV * 1_000 + (10_000 - input.id)
			);
		};

		let best: LeaderScoreInput = {
			lteCapable: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
		};

		for (const n of this.neighbors.values()) {
			const candidate: LeaderScoreInput = {
				lteCapable: n.lteCapable ?? false,
				degree: n.degree ?? degree,
				batteryV: n.batteryV ?? 0,
				id: n.id,
			};
			if (score(candidate) > score(best)) {
				best = candidate;
			}
		}

		this.leaderId = best.id;
		this.role = best.id === this.id ? NodeRole.LEADER : NodeRole.RELAY;
		if (this.state === "ISOLATED") this.role = NodeRole.ISOLATED;

		// Broadcast HELLO with minimal status
		const hello: Packet = {
			id: `${this.id}-hello-${now}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "HELLO",
				range: 0,
				angle: 0,
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				lteCapable: this.lteCapable,
			},
			timestamp: now,
		};
		this.hal.radioSend(hello);
	}

	private runGraphOptimization(dtMs: number) {
		if (this.neighbors.size === 0) return;
		const lr = this.cfg.learningRate * (dtMs / 1000);

		let gradX = 0;
		let gradY = 0;

		for (const n of this.neighbors.values()) {
			const dx = this.est.x - n.rangeMeters * Math.cos(n.angleRad ?? 0);
			const dy = this.est.y - n.rangeMeters * Math.sin(n.angleRad ?? 0);
			const distErr = Math.sqrt(dx * dx + dy * dy) - n.rangeMeters;
			gradX += this.cfg.lambdaDistance * 2 * distErr * (dx / (Math.abs(distErr) + 1e-6));
			gradY += this.cfg.lambdaDistance * 2 * distErr * (dy / (Math.abs(distErr) + 1e-6));

			if (n.angleRad !== undefined) {
				const currentAngle = Math.atan2(dy, dx);
				let angleErr = currentAngle - (n.angleRad ?? 0);
				while (angleErr > Math.PI) angleErr -= 2 * Math.PI;
				while (angleErr < -Math.PI) angleErr += 2 * Math.PI;
				const perpX = -Math.sin(currentAngle);
				const perpY = Math.cos(currentAngle);
				gradX += this.cfg.lambdaAngle * 2 * angleErr * perpX;
				gradY += this.cfg.lambdaAngle * 2 * angleErr * perpY;
			}
		}

		this.est.x -= lr * gradX;
		this.est.y -= lr * gradY;
	}

	public getSnapshot(): FirmwareSnapshot {
		return {
			id: this.id,
			role: this.role,
			state: this.state,
			batteryV: this.hal.getBatteryVoltage(),
			estPosition: { ...this.est },
			neighbors: Array.from(this.neighbors.values()).map((n) => ({
				id: n.id,
				rangeMeters: n.rangeMeters,
				angleRad: n.angleRad,
				timestamp: n.timestamp,
			})),
			leaderId: this.leaderId,
			lastAckMs: this.lastAckMs,
		};
	}
}
