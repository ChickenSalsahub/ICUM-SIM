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
	private lastRangePollMs = 0;
	private lastHelloMs = 0;
	private lastNeighborSignature: string = "";
	private lastTopologyChangeMs = 0;
	private lteCapable: boolean;
	private leaderId: number | null = null;

	constructor(id: number, hal: INodeHAL, cfg?: Partial<FirmwareConfig>, opts?: { lteCapable?: boolean }) {
		this.id = id;
		this.hal = hal;
		this.cfg = {
			accelMoveThresholdG: 0.5,
			isolationNoAckMs: 30_000,
			neighborTimeoutMs: 5_000,
			lambdaDistance: 1.0,
			lambdaAngle: 0.5,
			learningRate: 0.2, // spring-relaxation step (matches paper's α)
			...cfg,
		};
		this.lteCapable = opts?.lteCapable ?? false;
	}

	public tick(dtMs: number) {
		const now = this.hal.getTimeMs();
		this.consumeRadio(now);
		this.pruneStaleNeighbors(now);
		this.detectTopologyChange(now);
		this.maybeSendRangingPoll(now);
		this.updateStateFromImu(now);
		this.runLeaderElection(now);
		this.maybeSendHello(now);
		this.runGraphOptimization(dtMs);
	}

	private detectTopologyChange(now: number) {
		const ids = Array.from(this.neighbors.keys()).sort((a, b) => a - b);
		const sig = ids.join(",");
		if (sig !== this.lastNeighborSignature) {
			this.lastNeighborSignature = sig;
			this.lastTopologyChangeMs = now;
		}
	}

	private pruneStaleNeighbors(now: number) {
		const timeoutMs = this.cfg.neighborTimeoutMs;
		for (const [id, n] of this.neighbors.entries()) {
			if (now - n.lastSeenMs > timeoutMs) this.neighbors.delete(id);
		}
	}
	// Handle incoming radio packets
	private consumeRadio(now: number) {
		const packets = this.hal.pollRadio();
		for (const p of packets) {
			//skip packets not addressed to this node or broadcast
			if (p.destId !== -1 && p.destId !== this.id) continue;
			// Any successful reception implies connectivity (prevents everyone timing out into ISOLATED)
			if (p.srcId !== this.id) this.lastAckMs = now;
			if (p.type === PacketType.DATA && p.payload?.type === "HELLO") this.recordNeighborObservation(p, now);

			//Ranging packets
			if (p.type === PacketType.DATA && (p.payload?.type === "RANGING_POLL" || p.payload?.type === "RANGING_RESP")) {
				this.recordNeighborObservation(p, now);

				//if someone asked us for ranging, respond
				if (p.payload?.type === "RANGING_POLL" && p.srcId !== this.id) {
					const degree = this.neighbors.size;
					const resp: Packet = {
						id: `${this.id}-resp-${p.id}`,
						type: PacketType.DATA,
						srcId: this.id,
						destId: p.srcId,
						payload: {
							type: "RANGING_RESP",
							range: 0,
							angle: 0,
							degree,
							batteryV: this.hal.getBatteryVoltage(),
							lteCapable: this.lteCapable,
						},
						timestamp: now,
					};
					this.hal.radioSend(resp);
				}
			}
			//ACK is used to detect isolation state (if no ACKs received for a while, node is isolated)
			if (p.payload?.type === "ACK") {
				this.lastAckMs = now;
			}
		}
	}

	//Record or update a neighbor observation
	//neighbor observation is a record of a neighboring node's state as observed by this node
	private recordNeighborObservation(p: Packet, now: number) {
		const prev = this.neighbors.get(p.srcId);
		const next: NeighborState = {
			id: p.srcId,
			rangeMeters: p.payload?.range ?? p.payload?.rangeMeters ?? prev?.rangeMeters ?? 0,
			angleRad: p.payload?.angle ?? prev?.angleRad,
			timestamp: now,
			lastSeenMs: now,
			batteryV: p.payload?.batteryV ?? prev?.batteryV,
			degree: p.payload?.degree ?? prev?.degree,
			lteCapable: p.payload?.lteCapable ?? prev?.lteCapable,
		};
		this.neighbors.set(p.srcId, next);
	}

	///Send a ranging poll if enough time has passed since the last one
	private maybeSendRangingPoll(now: number) {
		// Adaptive sensing:
		// - When moving, poll frequently.
		// - When stationary, poll frequently only if topology changed recently.
		//   Otherwise, slow down to reduce churn.
		const FAST_MS = 1_000;
		const SLOW_MS = 10_000;
		const TOPOLOGY_RECENT_MS = 5_000;

		const isMoving = this.state === "MOVING";
		const topologyRecentlyChanged = now - this.lastTopologyChangeMs <= TOPOLOGY_RECENT_MS;
		const intervalMs = isMoving || topologyRecentlyChanged ? FAST_MS : SLOW_MS;
		if (now - this.lastRangePollMs < intervalMs) return;
		this.lastRangePollMs = now;
		const degree = this.neighbors.size;
		const poll: Packet = {
			id: `${this.id}-poll-${now}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "RANGING_POLL",
				range: 0,
				angle: 0,
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				lteCapable: this.lteCapable,
			},
			timestamp: now,
		};
		this.hal.radioSend(poll);
	}

	///Update the node's state based on IMU readings
	private updateStateFromImu(now: number) {
		const imu = this.hal.getIMU();
		// Treat IMU accel as including gravity; classify motion by linear acceleration magnitude.
		const linAx = imu.accel.x;
		const linAy = imu.accel.y;
		const linAz = imu.accel.z - 9.81;
		const linAccelMag = Math.sqrt(linAx ** 2 + linAy ** 2 + linAz ** 2);
		const linAccelG = linAccelMag / 9.81;

		const isMoving = linAccelG > this.cfg.accelMoveThresholdG;
		const disconnected = now - this.lastAckMs > this.cfg.isolationNoAckMs;

		// Isolation is a connectivity state: it can happen whether moving or stationary.
		if (disconnected) {
			this.state = "ISOLATED";
			return;
		}

		// If we were isolated and connectivity is back, recover based on IMU.
		if (this.state === "ISOLATED") {
			this.state = isMoving ? "MOVING" : "STATIONARY";
			return;
		}

		// Normal motion classification.
		if (isMoving) {
			this.state = "MOVING";
		} else if (this.state === "MOVING") {
			this.state = "STATIONARY";
		}
	}

	///if this node is the best candidate for leader, set role to LEADER, else RELAY or ISOLATED
	private runLeaderElection(_now: number) {
		const degree = this.neighbors.size;

		// A node with no neighbors should not claim cluster leadership.
		// Keep it IDLE (or ISOLATED if disconnected) until it has at least one neighbor.
		if (degree === 0) {
			this.leaderId = null;
			this.role = this.state === "ISOLATED" ? NodeRole.ISOLATED : NodeRole.IDLE;
			return;
		}
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
	}

	private maybeSendHello(now: number) {
		// Keepalive HELLO:
		// - Fast when moving/topology is changing.
		// - Slow when stationary and stable, but still frequent enough to prevent
		//   the whole network from going silent (and timing out into ISOLATED).
		const FAST_MS = 1_000;
		const SLOW_MS = 5_000;
		const TOPOLOGY_RECENT_MS = 5_000;
		const isMoving = this.state === "MOVING";
		const topologyRecentlyChanged = now - this.lastTopologyChangeMs <= TOPOLOGY_RECENT_MS;
		const intervalMs = isMoving || topologyRecentlyChanged ? FAST_MS : SLOW_MS;
		if (now - this.lastHelloMs < intervalMs) return;
		this.lastHelloMs = now;
		const degree = this.neighbors.size;
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

	//spring relaxation graph optimization
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

	//Get a snapshot of the current firmware state
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
