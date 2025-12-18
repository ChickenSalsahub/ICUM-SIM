import { NodeRole, Packet, PacketType } from "../types";
import { FirmwareConfig, FirmwareSnapshot, INodeHAL, NeighborObservation, NodePoseEstimate } from "./types";

interface NeighborState extends NeighborObservation {
	lastSeenMs: number;
	batteryV?: number;
	degree?: number;
	lteCapable?: boolean;
	leaderId?: number;
	leaderScore?: number;
	estX?: number;
	estY?: number;
}

interface LeaderScoreInput {
	lteCapable: boolean;
	degree: number;
	batteryV: number;
	id: number;
}

type UplinkNeighbor = { id: number; range: number; aoa?: number };

type UplinkNodeReport = {
	nodeId: number;
	timestamp: number;
	batteryV: number;
	status: "MOVING" | "STATIONARY";
	lteCapable: boolean;
	neighbors: UplinkNeighbor[];
	topologyVersion?: number;
	degree?: number;
	estX?: number;
	estY?: number;
};

type UplinkEvent = {
	kind: "TOPOLOGY_CHANGE";
	level: "INFO" | "WARN" | "ERROR";
	timestamp: number;
	nodeId: number;
	message: string;
};

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
	private lastNeighborCount = 0;
	private lastTopologyChangeMs = 0;
	private pendingTopologyEvent: { timestamp: number; prevCount: number; nextCount: number } | null = null;
	private topologyVersion = 0;
	private lastUplinkTopologyVersionByNode: Map<number, number> = new Map();
	private lteCapable: boolean;
	private leaderId: number | null = null;
	private leaderNextHop: number | null = null;
	private lastPanicMs = -1;
	private lastUplinkMs = 0;
	private forwardedUplinkByNode: Map<number, { report: UplinkNodeReport; lastSeenMs: number }> = new Map();
	private seenUplinkGossip: Map<string, number> = new Map();

	private pruneSeenUplinkGossip(now: number) {
		// Opportunistic cleanup to avoid unbounded growth.
		if (this.seenUplinkGossip.size <= 500) return;
		for (const [k, t] of this.seenUplinkGossip.entries()) {
			if (now - t > 60_000) this.seenUplinkGossip.delete(k);
		}
	}

	constructor(id: number, hal: INodeHAL, cfg?: Partial<FirmwareConfig>, opts?: { lteCapable?: boolean }) {
		this.id = id;
		this.hal = hal;
		this.cfg = {
			accelMoveThresholdG: 0.5,
			isolationNoAckMs: 30_000,
			neighborTimeoutMs: 20_000,
			eventDrivenSensing: true,
			helloIntervalMovingMs: 1_000,
			helloIntervalIdleMs: 15_000,
			rangingIntervalMovingMs: 1_000,
			rangingIntervalIdleMs: 10_000,
			rangingMaintenanceMs: 0,
			lambdaDistance: 1.0,
			lambdaAngle: 0.5,
			learningRate: 0.2, // spring-relaxation step (matches paper's α)
			...cfg,
		};
		this.lteCapable = opts?.lteCapable ?? false;
	}

	public tick(dtMs: number) {
		const now = this.hal.getTimeMs();
		const prevState = this.state;
		this.consumeRadio(now);
		this.pruneStaleNeighbors(now);
		this.detectTopologyChange(now);
		this.updateStateFromImu(now);
		const stateChanged = this.state !== prevState;

		// If we have entered (or remain in) ISOLATED, emit a PANIC packet.
		// This is primarily for observability (packet sniffer) and can also be used by
		// other components as an explicit alarm signal.
		if (this.state === "ISOLATED") {
			const PANIC_REPEAT_MS = 5_000;
			if (prevState !== "ISOLATED" || this.lastPanicMs < 0 || now - this.lastPanicMs >= PANIC_REPEAT_MS) {
				this.sendPanic(now);
			}
		}

		this.runLeaderElection(now);
		this.maybeSendUplink(now, prevState, stateChanged);
		this.maybeSendRangingPoll(now, prevState, stateChanged);
		this.maybeSendHello(now);
		this.runGraphOptimization(dtMs);
	}

	private statusForCloud(): "MOVING" | "STATIONARY" {
		return this.state === "MOVING" ? "MOVING" : "STATIONARY";
	}

	private buildLocalUplinkReport(now: number): UplinkNodeReport {
		const neighbors = Array.from(this.neighbors.values())
			.filter((n) => Number.isFinite(n.rangeMeters) && (n.rangeMeters ?? 0) > 0)
			.map((n) => ({
				id: n.id,
				range: n.rangeMeters,
				aoa: n.angleRad,
			}));

		return {
			nodeId: this.id,
			timestamp: now,
			batteryV: this.hal.getBatteryVoltage(),
			status: this.statusForCloud(),
			lteCapable: this.lteCapable,
			neighbors,
			// Optional observability/debug fields
			topologyVersion: this.topologyVersion,
			degree: this.neighbors.size,
			estX: this.est.x,
			estY: this.est.y,
		};
	}

	private maybeSendUplink(now: number, prevState: NodeFirmware["state"], stateChanged: boolean) {
		// Uplink policy:
		// - Non-leaders never send to the backend directly. They gossip their report to the current leader.
		// - Leaders/root send a batched uplink (self + forwarded reports).
		//
		// Cadence mirrors HELLO/ranging gating: fast when moving/topology changing, slow when stable.
		const FAST_MS = this.cfg.helloIntervalMovingMs ?? 1_000;
		const SLOW_MS = this.cfg.helloIntervalIdleMs ?? 15_000;
		const TOPOLOGY_RECENT_MS = 5_000;
		const topologyRecentlyChanged = now - this.lastTopologyChangeMs <= TOPOLOGY_RECENT_MS;
		const isMoving = this.state === "MOVING";
		const intervalMs =
			this.cfg.eventDrivenSensing === false
				? FAST_MS
				: isMoving || topologyRecentlyChanged || stateChanged || (prevState === "ISOLATED" && this.state !== "ISOLATED")
				? FAST_MS
				: SLOW_MS;

		if (now - this.lastUplinkMs < intervalMs) return;
		this.lastUplinkMs = now;

		const local = this.buildLocalUplinkReport(now);

		const isUplinkNode = this.role === NodeRole.LEADER || this.lteCapable;
		if (!isUplinkNode) {
			// Send report toward leader via TTL-limited gossip flood.
			// Prefer unicast routing via leaderNextHop (tree), with TTL as a safety net.
			if (this.leaderId !== null && this.leaderId !== this.id && this.leaderNextHop !== null) {
				const INITIAL_TTL = 4;
				const pkt: Packet = {
					id: `${this.id}-uplink-gossip-${now}`,
					type: PacketType.DATA,
					srcId: this.id,
					destId: this.leaderNextHop,
					payload: {
						type: "UPLINK_GOSSIP",
						targetLeaderId: this.leaderId,
						ttl: INITIAL_TTL,
						report: local,
					},
					timestamp: now,
				};
				this.hal.radioSend(pkt);
			}
			return;
		}

		// Leader/root: send self report + any forwarded reports.
		const reports: UplinkNodeReport[] = [local];
		for (const { report } of this.forwardedUplinkByNode.values()) {
			reports.push(report);
		}
		this.forwardedUplinkByNode.clear();

		const events: UplinkEvent[] = [];
		if (this.role === NodeRole.LEADER && this.pendingTopologyEvent) {
			const { timestamp, prevCount, nextCount } = this.pendingTopologyEvent;
			events.push({
				kind: "TOPOLOGY_CHANGE",
				level: "INFO",
				timestamp,
				nodeId: this.id,
				message: `leader ${this.id} topology changed (neighbors ${prevCount} -> ${nextCount})`,
			});
			this.pendingTopologyEvent = null;
		}

		// Also surface topology changes observed from leaf/relay nodes (via their reports).
		if (this.role === NodeRole.LEADER) {
			for (const r of reports) {
				if (!r || typeof r !== "object") continue;
				if (r.nodeId === this.id) continue;
				const v = Number(r.topologyVersion);
				if (!Number.isFinite(v) || v <= 0) continue;
				const prev = this.lastUplinkTopologyVersionByNode.get(r.nodeId) ?? 0;
				if (v <= prev) continue;
				this.lastUplinkTopologyVersionByNode.set(r.nodeId, v);
				events.push({
					kind: "TOPOLOGY_CHANGE",
					level: "INFO",
					timestamp: r.timestamp,
					nodeId: r.nodeId,
					message: `node ${r.nodeId} topology changed (v${prev} -> v${v}, degree=${r.degree ?? "?"})`,
				});
			}
		}

		const uplink: Packet = {
			id: `${this.id}-uplink-${now}`,
			type: PacketType.UPLINK,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "UPLINK_BATCH",
				reports,
				...(events.length > 0 ? { events } : {}),
			},
			timestamp: now,
		};
		this.hal.radioSend(uplink);
	}

	private sendPanic(now: number) {
		this.lastPanicMs = now;
		const degree = this.neighbors.size;
		const pkt: Packet = {
			id: `${this.id}-panic-${now}`,
			type: PacketType.PANIC,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "PANIC",
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				lteCapable: this.lteCapable,
			},
			timestamp: now,
		};
		this.hal.radioSend(pkt);
	}

	private detectTopologyChange(now: number) {
		const ids = Array.from(this.neighbors.keys()).sort((a, b) => a - b);
		const sig = ids.join(",");
		if (sig !== this.lastNeighborSignature) {
			const prevCount = this.lastNeighborCount;
			const nextCount = ids.length;
			this.lastNeighborSignature = sig;
			this.lastNeighborCount = nextCount;
			this.lastTopologyChangeMs = now;
			this.topologyVersion += 1;
			this.pendingTopologyEvent = { timestamp: now, prevCount, nextCount };
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

			// PANIC: immediately ACK the sender.
			// This provides a fast, explicit "I heard you" response for alarm packets.
			if ((p.type === PacketType.PANIC || p.payload?.type === "PANIC") && p.srcId !== this.id) {
				const ack: Packet = {
					id: `${this.id}-ack-panic-${p.id}`,
					type: PacketType.DATA,
					srcId: this.id,
					destId: p.srcId,
					payload: {
						type: "ACK",
						reason: "PANIC",
						forId: p.id,
					},
					timestamp: now,
				};
				this.hal.radioSend(ack);
			}
			if (p.payload?.type === "HELLO") this.recordNeighborObservation(p, now);

			//Ranging packets
			if (p.payload?.type === "RANGING_POLL" || p.payload?.type === "RANGING_RESP") {
				this.recordNeighborObservation(p, now);

				//if someone asked us for ranging, respond
				if (p.payload?.type === "RANGING_POLL" && p.srcId !== this.id) {
					const degree = this.neighbors.size;
					const leaderScore = nodeScore({
						lteCapable: this.lteCapable,
						degree,
						batteryV: this.hal.getBatteryVoltage(),
						id: this.id,
					});
					const resp: Packet = {
						id: `${this.id}-resp-${p.id}`,
						type: PacketType.DATA,
						srcId: this.id,
						destId: p.srcId,
						payload: {
							type: "RANGING_RESP",
							range: 0,
							angle: 0,
							estX: this.est.x,
							estY: this.est.y,
							degree,
							batteryV: this.hal.getBatteryVoltage(),
							lteCapable: this.lteCapable,
							leaderId: this.leaderId ?? this.id,
							leaderScore,
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

			// Uplink gossip: non-leaders send their cloud report to the current leader.
			if (p.payload?.type === "UPLINK_GOSSIP") {
				const payload = p.payload as { report?: UplinkNodeReport; targetLeaderId?: unknown; ttl?: unknown };
				const report = payload.report;
				if (!report) continue;
				const targetLeaderId = Number(payload.targetLeaderId);
				const ttl = Number.isFinite(Number(payload.ttl)) ? Number(payload.ttl) : 0;
				const key = `${Number.isFinite(targetLeaderId) ? targetLeaderId : "?"}-${report.nodeId}-${report.timestamp}`;
				// Best-effort dedupe to avoid re-forward loops.
				const prevSeen = this.seenUplinkGossip.get(key);
				if (prevSeen !== undefined && now - prevSeen < 30_000) continue;
				this.seenUplinkGossip.set(key, now);
				this.pruneSeenUplinkGossip(now);

				const isTargetLeader = Number.isFinite(targetLeaderId) && targetLeaderId === this.id;

				// If this node is the intended target leader, accept the report immediately.
				// Leader election runs later in the tick, so role may not be updated yet.
				if (isTargetLeader) {
					this.forwardedUplinkByNode.set(report.nodeId, { report, lastSeenMs: now });
					continue;
				}

				// Prefer unicast toward our current next hop; fallback to broadcast if we don't have one.
				if (ttl > 0 && p.srcId !== this.id) {
					const nextHop = this.leaderNextHop;
					const fwd: Packet = {
						id: `${this.id}-uplink-gossip-fwd-${key}`,
						type: PacketType.DATA,
						srcId: this.id,
						destId: nextHop !== null && nextHop !== this.id ? nextHop : -1,
						payload: {
							type: "UPLINK_GOSSIP",
							targetLeaderId: Number.isFinite(targetLeaderId) ? targetLeaderId : undefined,
							ttl: ttl - 1,
							report,
						},
						timestamp: now,
					};
					this.hal.radioSend(fwd);
				}
			}
		}
	}

	//Record or update a neighbor observation
	//neighbor observation is a record of a neighboring node's state as observed by this node
	private recordNeighborObservation(p: Packet, now: number) {
		const prev = this.neighbors.get(p.srcId);
		const payloadEstX = p.payload?.estX;
		const payloadEstY = p.payload?.estY;
		const payloadLeaderId = p.payload?.leaderId;
		const payloadLeaderScore = p.payload?.leaderScore;
		const next: NeighborState = {
			id: p.srcId,
			rangeMeters: p.payload?.range ?? p.payload?.rangeMeters ?? prev?.rangeMeters ?? 0,
			angleRad: p.payload?.angle ?? prev?.angleRad,
			timestamp: now,
			lastSeenMs: now,
			batteryV: p.payload?.batteryV ?? prev?.batteryV,
			degree: p.payload?.degree ?? prev?.degree,
			lteCapable: p.payload?.lteCapable ?? prev?.lteCapable,
			leaderId: Number.isFinite(payloadLeaderId) ? payloadLeaderId : prev?.leaderId,
			leaderScore: Number.isFinite(payloadLeaderScore) ? payloadLeaderScore : prev?.leaderScore,
			estX: Number.isFinite(payloadEstX) ? payloadEstX : prev?.estX,
			estY: Number.isFinite(payloadEstY) ? payloadEstY : prev?.estY,
		};
		this.neighbors.set(p.srcId, next);
	}

	///Send a ranging poll if enough time has passed since the last one
	private hasIncompleteNeighborInfo() {
		for (const n of this.neighbors.values()) {
			// Range comes only from ranging injection; HELLOs default to 0.
			if (!Number.isFinite(n.rangeMeters) || n.rangeMeters <= 0) return true;
			if (n.angleRad === undefined) return true;
		}
		return false;
	}

	///Send a ranging poll if policy allows
	private maybeSendRangingPoll(now: number, prevState: NodeFirmware["state"], stateChanged: boolean) {
		const TOPOLOGY_RECENT_MS = 5_000;
		const isMoving = this.state === "MOVING";
		const topologyRecentlyChanged = now - this.lastTopologyChangeMs <= TOPOLOGY_RECENT_MS;
		const recoveredFromIsolation = prevState === "ISOLATED" && this.state !== "ISOLATED";
		const needsLearning = this.hasIncompleteNeighborInfo();

		const movingIntervalMs = this.cfg.rangingIntervalMovingMs ?? 1_000;
		const idleIntervalMs = this.cfg.rangingIntervalIdleMs ?? 10_000;
		const maintenanceMs = this.cfg.rangingMaintenanceMs ?? 0;

		// ICUM event-driven mode: when stationary+stable, only range on events or when
		// we still lack measurements.
		if (this.cfg.eventDrivenSensing && !isMoving && !topologyRecentlyChanged) {
			const shouldFire = recoveredFromIsolation || stateChanged || needsLearning;
			if (!shouldFire) {
				if (maintenanceMs > 0 && now - this.lastRangePollMs >= maintenanceMs) {
					// fallthrough to send a very slow maintenance poll
				} else {
					return;
				}
			}
		}

		const intervalMs =
			this.cfg.eventDrivenSensing === false
				? movingIntervalMs
				: isMoving || topologyRecentlyChanged
				? movingIntervalMs
				: idleIntervalMs;
		if (now - this.lastRangePollMs < intervalMs) return;
		this.lastRangePollMs = now;
		const degree = this.neighbors.size;
		const leaderScore = nodeScore({
			lteCapable: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
		});
		const poll: Packet = {
			id: `${this.id}-poll-${now}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "RANGING_POLL",
				range: 0,
				angle: 0,
				estX: this.est.x,
				estY: this.est.y,
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				lteCapable: this.lteCapable,
				leaderId: this.leaderId ?? this.id,
				leaderScore,
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
			this.leaderNextHop = null;
			this.pendingTopologyEvent = null;
			this.lastUplinkTopologyVersionByNode.clear();
			this.role = this.state === "ISOLATED" ? NodeRole.ISOLATED : NodeRole.IDLE;
			return;
		}

		const self: LeaderScoreInput = {
			lteCapable: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
		};
		let bestLeaderId = this.id;
		let bestLeaderScore = nodeScore(self);
		let bestNextHop: number | null = null;

		for (const n of this.neighbors.values()) {
			const directCandidate: LeaderScoreInput = {
				lteCapable: n.lteCapable ?? false,
				degree: n.degree ?? degree,
				batteryV: n.batteryV ?? 0,
				id: n.id,
			};
			const neighborLeaderId = n.leaderId;
			const neighborLeaderScore = n.leaderScore;
			const candidateLeaderId = Number.isFinite(neighborLeaderId) ? neighborLeaderId! : directCandidate.id;
			const candidateLeaderScore = Number.isFinite(neighborLeaderScore)
				? neighborLeaderScore!
				: nodeScore(directCandidate);
			if (candidateLeaderScore > bestLeaderScore) {
				bestLeaderScore = candidateLeaderScore;
				bestLeaderId = candidateLeaderId;
				bestNextHop = n.id;
			}
		}

		this.leaderId = bestLeaderId;
		this.leaderNextHop = bestLeaderId === this.id ? null : bestNextHop;
		this.role = bestLeaderId === this.id ? NodeRole.LEADER : NodeRole.RELAY;
		if (this.state === "ISOLATED") this.role = NodeRole.ISOLATED;
	}

	private maybeSendHello(now: number) {
		// Keepalive HELLO:
		// - Fast when moving/topology is changing.
		// - Much slower when stationary+stable to reduce chatter while keeping
		//   neighbor tables alive.
		const FAST_MS = this.cfg.helloIntervalMovingMs ?? 1_000;
		const SLOW_MS = this.cfg.helloIntervalIdleMs ?? 15_000;
		const TOPOLOGY_RECENT_MS = 5_000;
		const isMoving = this.state === "MOVING";
		const topologyRecentlyChanged = now - this.lastTopologyChangeMs <= TOPOLOGY_RECENT_MS;
		const intervalMs =
			this.cfg.eventDrivenSensing === false ? FAST_MS : isMoving || topologyRecentlyChanged ? FAST_MS : SLOW_MS;
		if (now - this.lastHelloMs < intervalMs) return;
		this.lastHelloMs = now;
		const degree = this.neighbors.size;
		const leaderScore = nodeScore({
			lteCapable: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
		});
		const hello: Packet = {
			id: `${this.id}-hello-${now}`,
			type: PacketType.HELLO,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "HELLO",
				range: 0,
				angle: 0,
				estX: this.est.x,
				estY: this.est.y,
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				lteCapable: this.lteCapable,
				leaderId: this.leaderId ?? this.id,
				leaderScore,
			},
			timestamp: now,
		};
		this.hal.radioSend(hello);
	}

	// Cooperative localization update.
	//
	// Each neighbor provides:
	// - their current estimated position (estX/estY) in a shared evolving frame
	// - a measured range+bearing from *self -> neighbor* (rangeMeters/angleRad)
	//
	// From a neighbor j, self can infer where it should be:
	//   p_i ~= p_j - r_ij * [cos(theta_ij), sin(theta_ij)]
	// We take a weighted average over all such inferences and move toward it.
	//
	// This is intentionally simpler and more stable than the old per-tick summed-gradient
	// update (which tended to produce weird non-monotonic noise curves).
	private runGraphOptimization(dtMs: number) {
		if (this.neighbors.size === 0) return;
		let sumX = 0;
		let sumY = 0;
		let used = 0;

		for (const n of this.neighbors.values()) {
			if (!Number.isFinite(n.rangeMeters) || n.rangeMeters <= 0) continue;
			if (n.angleRad === undefined) continue;
			const estX = n.estX;
			const estY = n.estY;
			if (estX === undefined || estY === undefined) continue;
			if (!Number.isFinite(estX) || !Number.isFinite(estY)) continue;

			const measDx = n.rangeMeters * Math.cos(n.angleRad);
			const measDy = n.rangeMeters * Math.sin(n.angleRad);
			const inferredSelfX = estX - measDx;
			const inferredSelfY = estY - measDy;
			if (!Number.isFinite(inferredSelfX) || !Number.isFinite(inferredSelfY)) continue;

			sumX += inferredSelfX;
			sumY += inferredSelfY;
			used++;
		}

		if (used === 0) return;
		const targetX = sumX / used;
		const targetY = sumY / used;

		// Smoothly move toward the inferred position; cap to avoid teleporting.
		const alpha = Math.min(1, Math.max(0, this.cfg.learningRate * (dtMs / 1000)));
		let stepX = (targetX - this.est.x) * alpha;
		let stepY = (targetY - this.est.y) * alpha;

		const stepNorm = Math.sqrt(stepX * stepX + stepY * stepY);
		const maxStepMeters = 0.5;
		if (stepNorm > maxStepMeters) {
			const scale = maxStepMeters / stepNorm;
			stepX *= scale;
			stepY *= scale;
		}

		this.est.x += stepX;
		this.est.y += stepY;
		if (!Number.isFinite(this.est.x) || !Number.isFinite(this.est.y)) {
			this.est = { x: 0, y: 0 };
		}
	}

	//Get a snapshot of the current firmware state
	public getSnapshot(): FirmwareSnapshot {
		return {
			id: this.id,
			role: this.role,
			state: this.state,
			lteCapable: this.lteCapable,
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

const nodeScore = (input: LeaderScoreInput) => {
	return (input.lteCapable ? 1 : 0) * 1_000_000 + input.degree * 10_000 + input.batteryV * 1_000 + (10_000 - input.id);
};
