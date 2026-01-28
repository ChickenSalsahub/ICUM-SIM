import { NodeRole, Packet, PacketType } from "../types";
import { FirmwareConfig, FirmwareSnapshot, INodeHAL, NeighborObservation, NodePoseEstimate } from "./types";

interface NeighborState extends NeighborObservation {
	lastSeenMs: number;
	batteryV?: number;
	degree?: number;
	lteCapable?: boolean;
	hasBackhaul?: boolean;
	status?: "MOVING" | "STATIONARY" | "ISOLATED";
	leaderId?: number;
	leaderVector?: PriorityVector;
	estX?: number;
	estY?: number;
}

interface PriorityVector {
	hasBackhaul: boolean;
	degree: number;
	batteryV: number;
	id: number;
	moving?: boolean;
}

type UplinkNeighbor = { id: number; range: number; aoa?: number };

type UplinkNodeReport = {
	nodeId: number;
	timestamp: number;
	batteryV: number;
	status: "MOVING" | "STATIONARY";
	lteCapable: boolean;
	gpsReport?: { lat: number; lng: number }; // [NEW] GPS Fallback
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

	private est: NodePoseEstimate = { x: 0, y: 0 }; //PoseGraph estimate
	private neighbors: Map<number, NeighborState> = new Map(); //PoseGraph of neighbors

	private lastAckMs = 0;
	private helloTimerMs: number;
	private rangingTimerMs: number;
	private blinkTimerMs: number;
	private uplinkTimerMs: number;
	private movingStopStartMs: number | null = null;
	private readonly helloOffsetMs: number;
	private readonly rangingOffsetMs: number;
	private readonly uplinkOffsetMs: number;
	private readonly neighborTimeoutOverride: boolean;
	private lastNeighborSignature: string = "";
	private lastNeighborCount = 0;
	private lastMeshTrafficMs = 0;
	private pendingTopologyEvent: { timestamp: number; prevCount: number; nextCount: number } | null = null;
	private topologyVersion = 0;
	private lastUplinkTopologyVersionByNode: Map<number, number> = new Map();
	private lteCapable: boolean;
	private gpsCapable: boolean;
	private leaderId: number | null = null;
	private leaderNextHop: number | null = null;
	private lastPanicMs = -1;
	private forwardedUplinkByNode: Map<number, { report: UplinkNodeReport; lastSeenMs: number }> = new Map();
	private seenUplinkGossip: Map<string, number> = new Map();
	private helloPrimed = false;

	private pruneSeenUplinkGossip(now: number) {
		// Opportunistic cleanup to avoid unbounded growth.
		if (this.seenUplinkGossip.size <= 500) return;
		for (const [k, t] of this.seenUplinkGossip.entries()) {
			if (now - t > 60_000) this.seenUplinkGossip.delete(k);
		}
	}

	constructor(
		id: number,
		hal: INodeHAL,
		cfg?: Partial<FirmwareConfig>,
		opts?: { lteCapable?: boolean; gpsCapable?: boolean },
	) {
		this.id = id;
		this.hal = hal;
		this.cfg = {
			accelMoveThresholdG: 0.5,
			isolationNoAckMs: 30_000,
			neighborTimeoutMs: 20_000,
			eventDrivenSensing: true,
			helloIntervalMovingMs: 1_000,
			helloIntervalIdleMs: 10_000,
			rangingIntervalMovingMs: 1_000,
			rangingIntervalIdleMs: 10_000,
			rangingMaintenanceMs: 0,
			lambdaDistance: 1.0, //for graph optimization weighting
			lambdaAngle: 0.5, // angular component omitted in optimization step
			learningRate: 0.2, // spring-relaxation step (matches paper's α)
			...cfg,
		};
		this.lteCapable = opts?.lteCapable ?? false;
		this.gpsCapable = opts?.gpsCapable ?? false;
		this.neighborTimeoutOverride = cfg?.neighborTimeoutMs !== undefined;

		// Randomized async offsets to avoid synchronized timers across nodes.
		const helloInterval = this.cfg.helloIntervalIdleMs ?? 15_000;
		const rangingInterval = this.cfg.rangingIntervalIdleMs ?? 10_000;
		const uplinkInterval = this.cfg.helloIntervalIdleMs ?? 15_000;
		const blinkInterval = 10_000;
		this.helloOffsetMs = Math.random() * helloInterval;
		this.rangingOffsetMs = Math.random() * rangingInterval;
		this.uplinkOffsetMs = Math.random() * uplinkInterval;
		this.helloTimerMs = this.helloOffsetMs;
		this.rangingTimerMs = this.rangingOffsetMs;
		this.blinkTimerMs = Math.random() * blinkInterval;
		this.uplinkTimerMs = this.uplinkOffsetMs;
		this.lastMeshTrafficMs = this.hal.getTimeMs();
	}

	//the main function called on every firmware tick
	public tick(dtMs: number) {
		const now = this.hal.getTimeMs();
		this.helloTimerMs += dtMs;
		this.rangingTimerMs += dtMs;
		this.blinkTimerMs += dtMs;
		this.uplinkTimerMs += dtMs;
		const prevState = this.state;
		this.consumeRadio(now);
		this.pruneStaleNeighbors(now);
		const topologyChanged = this.detectTopologyChange(now);
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
		if (topologyChanged && this.state === "STATIONARY") {
			this.sendMeshReport(now);
		}
		this.maybeSendHello(now);
		this.maybeSendBlink(now);
		this.maybeSendUplink(now, prevState, stateChanged);

		//The spring relaxation graph optimization step
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

		// [NEW] GPS Fallback: If isolated and capable, try to get global pos.
		let gpsReport: { lat: number; lng: number } | undefined;
		if (this.state === "ISOLATED" && this.gpsCapable) {
			const g = this.hal.getGlobalPosition();
			if (g) {
				gpsReport = { lat: g.lat, lng: g.lng };
			}
		}

		return {
			nodeId: this.id,
			timestamp: now,
			batteryV: this.hal.getBatteryVoltage(),
			status: this.statusForCloud(),
			lteCapable: this.lteCapable,
			gpsReport,
			neighbors,
			// Optional observability/debug fields
			topologyVersion: this.topologyVersion,
			degree: this.neighbors.size,
			estX: this.est.x,
			estY: this.est.y,
		};
	}

	private sendMeshReport(now: number) {
		const report = this.buildLocalUplinkReport(now);
		const targetLeaderId = this.leaderId ?? undefined;
		if (targetLeaderId === this.id) {
			this.forwardedUplinkByNode.set(this.id, { report, lastSeenMs: now });
			this.sendUplinkBatch(now);
			return;
		}
		const nextHop =
			this.leaderNextHop ?? (targetLeaderId !== undefined && targetLeaderId !== this.id ? targetLeaderId : null);
		if (nextHop === null) return;
		const pkt: Packet = {
			id: `${this.id}-mesh-report-${now}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: nextHop,
			payload: {
				type: "BLE_MESH_REPORT",
				targetLeaderId,
				ttl: 4,
				report,
			},
			timestamp: now,
		};
		this.hal.radioSend(pkt);
	}

	///Send a HELLO heartbeat if policy allows
	private maybeSendHello(now: number) {
		const useEventDriven = this.cfg.eventDrivenSensing !== false;
		if (useEventDriven && this.state !== "STATIONARY") return;
		const intervalMs = this.cfg.helloIntervalIdleMs ?? 10_000;
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
		if (!this.helloPrimed) {
			this.helloPrimed = true;
			this.helloTimerMs = intervalMs;
		}
		if (this.helloTimerMs < intervalMs) return;
		this.helloTimerMs = 0;
		const degree = this.neighbors.size;
		const leaderVector = makePriorityVector({
			hasBackhaul: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
			moving: false,
		});
		const hello: Packet = {
			id: `${this.id}-hello-${now}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "HELLO",
				batteryV: this.hal.getBatteryVoltage(),
				degree,
				hasBackhaul: this.lteCapable,
				leaderId: this.leaderId ?? this.id,
				leaderVector,
				status: this.state,
			},
			timestamp: now,
		};
		this.hal.radioSend(hello);
	}

	private maybeSendUplink(now: number, prevState: NodeFirmware["state"], stateChanged: boolean) {
		// Uplink is event-driven; only isolated nodes upload periodically via LTE/GPS.
		if (this.state !== "ISOLATED") return;
		if (!(this.lteCapable || this.gpsCapable)) return;
		const intervalMs = 10_000;
		if (this.uplinkTimerMs < intervalMs && !(prevState !== "ISOLATED" || stateChanged)) return;
		this.uplinkTimerMs = 0;
		const local = this.buildLocalUplinkReport(now);
		const uplink: Packet = {
			id: `${this.id}-uplink-${now}`,
			type: PacketType.UPLINK,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "UPLINK_BATCH",
				reports: [local],
			},
			timestamp: now,
		};
		this.hal.radioSend(uplink);
	}

	private sendUplinkBatch(now: number) {
		if (this.role !== NodeRole.LEADER) return;
		const local = this.buildLocalUplinkReport(now);
		const reports: UplinkNodeReport[] = [local];
		for (const { report } of this.forwardedUplinkByNode.values()) {
			reports.push(report);
		}
		this.forwardedUplinkByNode.clear();

		const events: UplinkEvent[] = [];
		if (this.pendingTopologyEvent) {
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
			this.topologyVersion += 1;
			this.pendingTopologyEvent = { timestamp: now, prevCount, nextCount };
			return true;
		}
		return false;
	}

	private pruneStaleNeighbors(now: number) {
		const helloIdleMs = this.cfg.helloIntervalIdleMs ?? 10_000;
		const timeoutMs = this.neighborTimeoutOverride
			? this.cfg.neighborTimeoutMs
			: Math.max(this.cfg.neighborTimeoutMs, helloIdleMs * 2);
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

			const payloadType = p.payload?.type;
			const isMeshTraffic =
				p.type === PacketType.UWB_BLINK ||
				p.type === PacketType.BLE_ACK ||
				payloadType === "UWB_BLINK" ||
				payloadType === "BLE_ACK" ||
				payloadType === "HELLO" ||
				payloadType === "RANGING_POLL" ||
				payloadType === "RANGING_RESP" ||
				payloadType === "BLE_MESH_REPORT" ||
				p.type === PacketType.PANIC;
			if (isMeshTraffic && p.srcId !== this.id) {
				this.lastMeshTrafficMs = now;
			}

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

			// UWB Blink handshake (ETM)
			if (p.type === PacketType.UWB_BLINK || p.payload?.type === "UWB_BLINK") {
				this.recordNeighborObservation(p, now);
				if (p.srcId !== this.id) {
					const degree = this.neighbors.size;
					const leaderVector = makePriorityVector({
						hasBackhaul: this.lteCapable,
						degree,
						batteryV: this.hal.getBatteryVoltage(),
						id: this.id,
						moving: this.state === "MOVING",
					});
					const ack: Packet = {
						id: `${this.id}-ble-ack-${p.id}`,
						type: PacketType.BLE_ACK,
						srcId: this.id,
						destId: p.srcId,
						payload: {
							type: "BLE_ACK",
							range: p.payload?.range ?? 0,
							angle: p.payload?.angle ?? 0,
							estX: this.est.x,
							estY: this.est.y,
							degree,
							batteryV: this.hal.getBatteryVoltage(),
							hasBackhaul: this.lteCapable,
							leaderId: this.leaderId ?? this.id,
							leaderVector,
							status: this.state,
						},
						timestamp: now,
					};
					this.hal.radioSend(ack);
				}
			}

			if (p.payload?.type === "HELLO") this.recordNeighborObservation(p, now);

			//Ranging packets
			if (p.payload?.type === "RANGING_POLL" || p.payload?.type === "RANGING_RESP") {
				this.recordNeighborObservation(p, now);

				//if someone asked us for ranging, respond
				if (p.payload?.type === "RANGING_POLL" && p.srcId !== this.id) {
					const degree = this.neighbors.size;
					const leaderVector = makePriorityVector({
						hasBackhaul: this.lteCapable,
						degree,
						batteryV: this.hal.getBatteryVoltage(),
						id: this.id,
						moving: this.state === "MOVING",
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
							hasBackhaul: this.lteCapable,
							leaderId: this.leaderId ?? this.id,
							leaderVector,
							status: this.state,
						},
						timestamp: now,
					};
					this.hal.radioSend(resp);
				}
			}
			// BLE_ACK updates connectivity for moving nodes and provides fresh ranging data.
			if (p.type === PacketType.BLE_ACK || p.payload?.type === "BLE_ACK") {
				this.lastAckMs = now;
				this.recordNeighborObservation(p, now);
				if (this.state !== "ISOLATED") {
					this.sendMeshReport(now);
				}
			}

			// ACK is used to detect isolation state (if no ACKs received for a while, node is isolated)
			if (p.payload?.type === "ACK") {
				this.lastAckMs = now;
			}

			// Mesh reports: non-leaders send their cloud report to the current leader.
			if (p.payload?.type === "UPLINK_GOSSIP" || p.payload?.type === "BLE_MESH_REPORT") {
				// Relay is OFF when isolated or moving.
				if (this.state === "ISOLATED" || this.state === "MOVING") continue;
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
					if (this.role === NodeRole.LEADER || this.leaderId === this.id) {
						this.forwardedUplinkByNode.set(report.nodeId, { report, lastSeenMs: now });
						this.sendUplinkBatch(now);
						continue;
					}

					// Relay received a report targeted to itself; forward toward its known leader if possible.
					const upstreamLeaderId = Number.isFinite(this.leaderId) ? this.leaderId : null;
					if (upstreamLeaderId !== null && upstreamLeaderId !== this.id && ttl > 0) {
						const nextHop = this.leaderNextHop ?? upstreamLeaderId;
						const fwd: Packet = {
							id: `${this.id}-mesh-report-fwd-${key}`,
							type: PacketType.DATA,
							srcId: this.id,
							destId: nextHop !== this.id ? nextHop : -1,
							payload: {
								type: "BLE_MESH_REPORT",
								targetLeaderId: upstreamLeaderId,
								ttl: ttl - 1,
								report,
							},
							timestamp: now,
						};
						this.hal.radioSend(fwd);
					}
					continue;
				}

				// Prefer unicast toward our current next hop; fallback to broadcast if we don't have one.
				if (ttl > 0 && p.srcId !== this.id) {
					const nextHop = this.leaderNextHop;
					const fwd: Packet = {
						id: `${this.id}-mesh-report-fwd-${key}`,
						type: PacketType.DATA,
						srcId: this.id,
						destId: nextHop !== null && nextHop !== this.id ? nextHop : -1,
						payload: {
							type: "BLE_MESH_REPORT",
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
		const payloadLeaderVector = p.payload?.leaderVector;
		const payloadStatus = p.payload?.status;
		const normalizedLeaderVector = payloadLeaderVector
			? makePriorityVector({
					id: Number.isFinite(payloadLeaderVector?.id)
						? Number(payloadLeaderVector.id)
						: Number.isFinite(payloadLeaderId)
							? Number(payloadLeaderId)
							: p.srcId,
					hasBackhaul:
						payloadLeaderVector?.hasBackhaul ??
						payloadLeaderVector?.lteCapable ??
						p.payload?.hasBackhaul ??
						p.payload?.lteCapable,
					degree: payloadLeaderVector?.degree ?? p.payload?.degree,
					batteryV: payloadLeaderVector?.batteryV ?? p.payload?.batteryV,
					moving: payloadLeaderVector?.moving,
				})
			: undefined;
		const next: NeighborState = {
			id: p.srcId,
			rangeMeters: p.payload?.range ?? p.payload?.rangeMeters ?? prev?.rangeMeters ?? 0,
			angleRad: p.payload?.angle ?? prev?.angleRad,
			timestamp: now,
			lastSeenMs: now,
			batteryV: p.payload?.batteryV ?? prev?.batteryV,
			degree: p.payload?.degree ?? prev?.degree,
			lteCapable: p.payload?.lteCapable ?? prev?.lteCapable,
			hasBackhaul: p.payload?.hasBackhaul ?? p.payload?.lteCapable ?? prev?.hasBackhaul ?? prev?.lteCapable,
			status:
				payloadStatus === "MOVING" || payloadStatus === "STATIONARY" || payloadStatus === "ISOLATED"
					? payloadStatus
					: prev?.status,
			leaderId: Number.isFinite(payloadLeaderId)
				? payloadLeaderId
				: Number.isFinite(normalizedLeaderVector?.id)
					? normalizedLeaderVector!.id
					: prev?.leaderId,
			leaderVector: normalizedLeaderVector ?? prev?.leaderVector,
			estX: Number.isFinite(payloadEstX) ? payloadEstX : prev?.estX,
			estY: Number.isFinite(payloadEstY) ? payloadEstY : prev?.estY,
		};
		this.neighbors.set(p.srcId, next);
	}

	///Send a UWB blink (ETM) if policy allows
	private maybeSendBlink(now: number) {
		const useEventDriven = this.cfg.eventDrivenSensing !== false;
		if (useEventDriven && this.state !== "MOVING") return;
		const intervalMs = useEventDriven ? 1_000 : (this.cfg.rangingIntervalMovingMs ?? 1_000);
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
		if (this.blinkTimerMs < intervalMs) return;
		this.blinkTimerMs = 0;
		const degree = this.neighbors.size;
		const leaderVector = makePriorityVector({
			hasBackhaul: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
			moving: this.state === "MOVING",
		});
		const blink: Packet = {
			id: `${this.id}-blink-${now}`,
			type: PacketType.UWB_BLINK,
			srcId: this.id,
			destId: -1,
			payload: {
				type: "UWB_BLINK",
				range: 0,
				angle: 0,
				estX: this.est.x,
				estY: this.est.y,
				degree,
				batteryV: this.hal.getBatteryVoltage(),
				hasBackhaul: this.lteCapable,
				leaderVector,
				status: this.state,
			},
			timestamp: now,
		};
		this.hal.radioSend(blink);
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
		const isolationMs = this.cfg.isolationNoAckMs;
		const disconnected = isMoving ? now - this.lastAckMs > isolationMs : now - this.lastMeshTrafficMs > isolationMs;

		// Isolation is a connectivity state: it can happen whether moving or stationary.
		if (disconnected) {
			this.state = "ISOLATED";
			this.movingStopStartMs = null;
			return;
		}

		// If we were isolated and connectivity is back, recover based on IMU.
		if (this.state === "ISOLATED") {
			this.state = isMoving ? "MOVING" : "STATIONARY";
			this.movingStopStartMs = null;
			return;
		}

		// Normal motion classification.
		if (isMoving) {
			this.state = "MOVING";
			this.movingStopStartMs = null;
			return;
		}

		// Require 5s continuous low-accel before switching to STATIONARY.
		if (this.state === "MOVING") {
			if (this.movingStopStartMs === null) this.movingStopStartMs = now;
			if (now - this.movingStopStartMs >= 5_000) {
				this.state = "STATIONARY";
			}
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

		const selfVector = makePriorityVector({
			hasBackhaul: this.lteCapable,
			degree,
			batteryV: this.hal.getBatteryVoltage(),
			id: this.id,
			moving: this.state === "MOVING",
		});
		const isEligible = (v: PriorityVector) => !v.moving;

		const bestCandidate = (() => {
			let best: { id: number; vector: PriorityVector; nextHop: number | null } | null = isEligible(selfVector)
				? { id: this.id, vector: selfVector, nextHop: null }
				: null;

			for (const n of this.neighbors.values()) {
				const neighborVector = makePriorityVector({
					hasBackhaul: n.hasBackhaul ?? n.lteCapable ?? false,
					degree: n.degree ?? degree,
					batteryV: n.batteryV ?? 0,
					id: n.id,
					moving: n.status === "MOVING",
				});
				if (!isEligible(neighborVector)) continue;
				if (!best || comparePriority(neighborVector, best.vector) > 0) {
					best = { id: n.id, vector: neighborVector, nextHop: n.id };
				}
			}

			return best;
		})();

		// Moving nodes are never eligible for leader/relay.
		if (this.state === "MOVING") {
			this.role = NodeRole.IDLE;
			this.leaderId = bestCandidate && bestCandidate.id !== this.id ? bestCandidate.id : null;
			this.leaderNextHop = bestCandidate && bestCandidate.id !== this.id ? bestCandidate.nextHop : null;
			return;
		}

		if (!bestCandidate) {
			this.leaderId = null;
			this.leaderNextHop = null;
			this.role = NodeRole.IDLE;
			return;
		}

		this.leaderId = bestCandidate.id;
		this.leaderNextHop = bestCandidate.id === this.id ? null : bestCandidate.nextHop;
		this.role = this.leaderId === this.id ? NodeRole.LEADER : NodeRole.RELAY;
		if (this.state === "ISOLATED") this.role = NodeRole.ISOLATED;
	}

	/**
	 * Distributed Graph Optimization (Spring Relaxation)
	 *
	 * Implements the core localization engine
	 * this uses a force-directed graph approach where every node locally relaxes its position to minimize stress on its edges.
	 */
	private runGraphOptimization(_dtMs: number) {
		// The network is modelled as a graph G=(V,E) where V are nodes and E are ranging constraints
		if (this.neighbors.size === 0) return;

		// Learning Rate (α) determines the stiffness of the springs or the step size of the gradient descent.
		const alpha = 0.2;

		// Iterate over all connected edges E (neighbors) to calculate forces on this node (Vertex i).
		for (const n of this.neighbors.values()) {
			// d_ij: The measured UWB range between node i and j (Equation 5)
			if (!Number.isFinite(n.rangeMeters) || n.rangeMeters <= 0) continue;

			// P_j: The current position estimate vector of the neighbor [x_j, y_j]^T
			const estX = n.estX;
			const estY = n.estY;
			if (estX === undefined || estY === undefined) continue;
			if (!Number.isFinite(estX) || !Number.isFinite(estY)) continue;

			// (P_j - P_i): The vector difference between neighbor and self.
			const dx = estX - this.est.x;
			const dy = estY - this.est.y;

			// ||P_j - P_i ||: The Euclidean distance of the current estimates
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (!Number.isFinite(dist) || dist === 0) continue;

			//Equation 5: Distance Error Term (e_dist)
			// e_dist(i,j) = || P_j - P_i || - d_ij
			// This represents the error between where the nodes *think* they are vs. what UWB measured.
			const eDist = dist - n.rangeMeters;

			//Correction Vector (ΔP_dist):  ΔP ~ α * e_dist * UnitVector
			//Calculate the scalar correction magnitude (α * e_dist)
			const corr = alpha * eDist;

			//Calculate the Unit Vector ( (P_j - P_i) / || P_j - P_i || )
			// This determines the direction of the force.
			const ux = dx / dist;
			const uy = dy / dist;

			//Apply the gradient descent step to minimize Cost Function J
			// This implementation only minimizes the Distance component (λ_d).
			// The Angular component (λ_theta) mentioned in Equation 4 is omitted here.
			// It is omitted as
			this.est.x += corr * ux;
			this.est.y += corr * uy;
		}

		// Safety: Reset to origin if the optimization diverges to Infinity/NaN.
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

//-- Leader Election Priority Comparison --
const comparePriority = (a: PriorityVector, b: PriorityVector): number => {
	const normalize = (v: PriorityVector) => ({
		hasBackhaul: Boolean(v.hasBackhaul),
		degree: Number.isFinite(v.degree) ? v.degree : 0,
		batteryTier: Number.isFinite(v.batteryV) ? Math.floor(v.batteryV * 10) : 0,
		id: Number.isFinite(v.id) ? v.id : Number.POSITIVE_INFINITY,
		moving: v.moving ?? false,
	});
	const A = normalize(a);
	const B = normalize(b);

	if (A.moving && !B.moving) return -1;
	if (B.moving && !A.moving) return 1;
	if (A.hasBackhaul !== B.hasBackhaul) return A.hasBackhaul ? 1 : -1;
	if (A.degree !== B.degree) return A.degree > B.degree ? 1 : -1;
	if (A.batteryTier !== B.batteryTier) return A.batteryTier > B.batteryTier ? 1 : -1;
	if (A.id !== B.id) return A.id < B.id ? 1 : -1;
	return 0;
};

const makePriorityVector = (input: {
	hasBackhaul?: boolean;
	degree?: number;
	batteryV?: number;
	id: number;
	moving?: boolean;
}): PriorityVector => ({
	hasBackhaul: Boolean(input.hasBackhaul),
	degree: Number.isFinite(input.degree) ? Number(input.degree) : 0,
	batteryV: Number.isFinite(input.batteryV) ? Number(input.batteryV) : 0,
	id: input.id,
	moving: input.moving ?? false,
});
