import { NodeRole, NodeType, NodeConfig, Packet, PacketType, NeighborEntry } from "../types";
import { CoopLocEngine } from "./localization/CooperativeLocalization";
import { IRangeMeasurement } from "./localization/types";

export class NodeFirmware {
	public id: number;
	public type: NodeType;
	public x: number;
	public y: number;
	public targetX: number;
	public targetY: number;

	public battery: number;
	public role: NodeRole;
	public state: "MOVING" | "STATIONARY";

	public neighbors: Map<number, NeighborEntry> = new Map();
	public txQueue: Packet[] = [];

	public hopsToGw: number = 999;
	public nextHop: number | null = null;
	public isolationTimer: number = 0;

	public isDragging: boolean = false;
	public isGossiping: boolean = false;
	public isElecting: boolean = false;

	public coopLoc: CoopLocEngine;

	private helloTimer: number;
	private gossipResetTimer: number = 0;
	private dataTimer: number;
	private txCooldownTimer: number = 0;
	private backendReportTimer: number = 0;

	private HELLO_INTERVAL = 1.0;
	private NEIGHBOR_TIMEOUT = 3.0;

	private lastX: number;
	private lastY: number;

	constructor(id: number, type: NodeType, x: number, y: number) {
		this.id = id;
		this.type = type;
		this.x = x;
		this.y = y;
		this.targetX = x;
		this.targetY = y;
		this.lastX = x;
		this.lastY = y;
		this.battery = Math.floor(Math.random() * 40) + 60;
		this.role = type === "HARDWARE_GW" ? NodeRole.ROOT : NodeRole.IDLE;
		this.state = type === "TRACKER" ? "MOVING" : "STATIONARY";
		if (this.type === "HARDWARE_GW") this.hopsToGw = 0;

		this.coopLoc = new CoopLocEngine(id);

		this.helloTimer = Math.random() * this.HELLO_INTERVAL;
		this.dataTimer = Math.random() * 2.0;
	}

	public tick(dt: number, config: NodeConfig, rxPackets: Packet[]) {
		this.updateMotion(dt, config);

		const movedX = this.x - this.lastX;
		const movedY = this.y - this.lastY;
		const PIXELS_PER_METER = 20; // Configurable?

		// Feed Odometry (converted to meters)
		if (movedX !== 0 || movedY !== 0) {
			this.coopLoc.update(dt, [], {
				dx: movedX / PIXELS_PER_METER,
				dy: movedY / PIXELS_PER_METER,
				dTheta: 0,
				timestamp: Date.now(),
			});
		}

		this.lastX = this.x;
		this.lastY = this.y;

		// 1. Inbox
		if (rxPackets.length > 0) {
			this.isGossiping = true;
			this.gossipResetTimer = 0.2;
			this.isolationTimer = 0;

			if (this.role === NodeRole.ISOLATED) {
				this.changeRole(NodeRole.IDLE, 999, null, PacketType.HELLO);
			}

			const batch = rxPackets.slice(0, 5);
			this.processInbox(batch);
		} else {
			if (this.gossipResetTimer > 0) this.gossipResetTimer -= dt;
			else this.isGossiping = false;
		}

		// Feed Ranges from Neighbors
		const ranges: IRangeMeasurement[] = [];
		for (const n of this.neighbors.values()) {
			if (n.rangeMeters !== undefined) {
				ranges.push({
					peerId: n.id,
					range: n.rangeMeters, // This is in meters
					aoa: n.aoa,
					timestamp: Date.now(),
				});
			}
		}

		if (ranges.length > 0) {
			this.coopLoc.update(dt, ranges);
		}

		// 2. Timers
		this.updateTimers(dt, config);
		if (this.txCooldownTimer > 0) this.txCooldownTimer -= dt;

		// 3. Consensus
		if (this.type !== "HARDWARE_GW") {
			this.ensureStability(dt, config);
		}

		// 4. Backend Reporting (Supernode only)
		if (this.type === "HARDWARE_GW") {
			this.backendReportTimer += dt;
			if (this.backendReportTimer >= 5.0) {
				this.backendReportTimer = 0;
				this.reportToBackend();
			}
		}
	}

	private async reportToBackend() {
		const nodes = [];
		// Iterate over all nodes in the local graph (including self)
		for (const [id, _pose] of this.coopLoc.graph.nodes) {
			const globalPos = this.coopLoc.getGlobalPosition(id);
			if (globalPos) {
				nodes.push({
					id,
					lat: globalPos.lat,
					lng: globalPos.lng,
					alt: globalPos.alt,
				});
			}
		}

		if (nodes.length > 0) {
			try {
				// In a real scenario, this URL would be in config
				await fetch("http://localhost:3000/api/locations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ timestamp: Date.now(), nodes }),
				});
				// console.log("Reported to backend:", nodes.length, "nodes");
			} catch (e) {
				// Ignore connection errors in simulation
				// console.warn("Backend report failed", e);
			}
		}
	}

	private processInbox(packets: Packet[]) {
		packets.forEach((p) => {
			if (p.type === PacketType.HELLO || p.type === PacketType.ELECTION || p.type === PacketType.PANIC) {
				this.neighbors.set(p.srcId, {
					id: p.srcId,
					role: p.payload.role,
					battery: p.payload.battery,
					hopsToGw: p.payload.hopsToGw,
					leaderId: p.payload.leaderId,
					leaderBat: p.payload.leaderBat,
					parentId: p.payload.parentId,
					neighborCount: p.payload.neighborCount,
					lastSeen: 0,
					rssi: -50,
					// If UWB ranging was attached to the packet, persist it
					rangeMeters: p.payload && (p.payload.__ranging ? p.payload.__ranging.measuredDistanceMeters : undefined),
					aoa: p.payload && (p.payload.__ranging ? p.payload.__ranging.aoa : undefined),
				});

				// PARENT FAILURE REACTION
				if (this.nextHop === p.srcId) {
					// If parent explicitly panicked or degraded
					if (p.type === PacketType.PANIC || p.payload.hopsToGw >= 999) {
						// My link to the world is gone. I must panic to notify my children.
						this.changeRole(NodeRole.IDLE, 999, null, PacketType.PANIC);
					}
				}
			}

			if (p.type === PacketType.DATA && this.role !== NodeRole.ROOT && this.role !== NodeRole.LEADER) {
				if (this.nextHop !== null && this.nextHop !== p.srcId) {
					if (this.txCooldownTimer <= 0) {
						this.forwardData(p);
						this.txCooldownTimer = 0.05;
					}
				}
			}
		});
	}

	private forwardData(originalPacket: Packet) {
		if (!this.nextHop) return;
		this.txQueue.push({
			id: `${this.id}-FWD-${originalPacket.id}`,
			type: PacketType.DATA,
			srcId: originalPacket.srcId,
			destId: this.nextHop,
			payload: originalPacket.payload,
			timestamp: Date.now(),
		});
	}

	private getSortedCandidates() {
		const candidates = [
			...Array.from(this.neighbors.values()),
			{
				id: this.id,
				role: this.role,
				battery: this.battery,
				hopsToGw: this.hopsToGw,
				neighborCount: this.neighbors.size,
				lastSeen: 0,
				rssi: 0,
			},
		];

		candidates.sort((a, b) => {
			// 1. HARDWARE (Hops < 100)
			const aHw = a.hopsToGw < 100;
			const bHw = b.hopsToGw < 100;
			if (aHw && !bHw) return -1;
			if (!aHw && bHw) return 1;
			if (aHw && bHw) return a.hopsToGw - b.hopsToGw;

			// 2. MOST NEIGHBORS (Centrality)
			const aCount = a.neighborCount ?? 0;
			const bCount = b.neighborCount ?? 0;
			if (aCount !== bCount) return bCount - aCount;

			// 3. BATTERY
			if (a.battery !== b.battery) return b.battery - a.battery;

			// 4. ID
			return a.id - b.id;
		});
		return candidates;
	}

	private ensureStability(dt: number, config: NodeConfig) {
		// 1. Isolation
		if (this.neighbors.size === 0) {
			this.handleIsolation(dt);
			return;
		}
		this.isolationTimer = 0;

		// 2. Hardware Gateway Check
		let bestHw = null;
		for (const n of this.neighbors.values()) {
			if (n.hopsToGw < 100) {
				if (!bestHw || n.hopsToGw < bestHw.hopsToGw) bestHw = n;
			}
		}

		if (bestHw) {
			this.isElecting = false;
			if (this.nextHop !== bestHw.id || this.role === NodeRole.LEADER) {
				this.changeRole(NodeRole.RELAY, bestHw.hopsToGw + 1, bestHw.id, PacketType.HELLO);
			}
			return;
		}

		// 3. CLUSTER SIZING (CRITICAL FIX)
		const candidates = this.getSortedCandidates();
		const clusterSizeEstimate = this.neighbors.size + 1;

		// FIX: Default is 1. We ALWAYS want at least 1 leader if no gateway exists.
		let allowedLeaders = 1;

		// Only increase to MaxLeaders (Redundancy) if we meet the size requirement
		if (clusterSizeEstimate >= config.minClusterSize) {
			allowedLeaders = config.maxLeaders;
		}

		const rulingCouncil = candidates.slice(0, allowedLeaders);
		const shouldBeLeader = rulingCouncil.some((c) => c.id === this.id);

		// Promotion
		if (shouldBeLeader && this.role !== NodeRole.LEADER) {
			this.runElection(config, allowedLeaders);
			return;
		}
		// Demotion
		if (!shouldBeLeader && this.role === NodeRole.LEADER) {
			this.runElection(config, allowedLeaders);
			return;
		}

		// 4. Cluster Merge Logic (Incumbent Check)
		if (this.role === NodeRole.LEADER) {
			let betterLeadersCount = 0;
			const seenLeaders = new Set<number>();

			for (const n of this.neighbors.values()) {
				const lBat = n.leaderBat || 0;
				const lId = n.leaderId || 0;
				// "Better" means Higher Battery OR Same Battery + Lower ID
				if (lBat > this.battery + 5 || (lBat === this.battery && lId < this.id)) {
					if (!seenLeaders.has(lId)) {
						betterLeadersCount++;
						seenLeaders.add(lId);
					}
				}
			}

			// If enough better leaders exist to fill the quota, I must step down
			if (betterLeadersCount >= allowedLeaders) {
				this.runElection(config, allowedLeaders);
				return;
			}
		}

		// 5. Relay Optimization
		if (this.role === NodeRole.RELAY || this.role === NodeRole.IDLE) {
			let best = null;
			for (const n of this.neighbors.values()) {
				if (n.parentId === this.id) continue;
				if (n.hopsToGw >= 999) continue;
				if (!best) best = n;
				else if (n.hopsToGw < best.hopsToGw) best = n;
				else if (n.hopsToGw === best.hopsToGw && (n.neighborCount || 0) > (best.neighborCount || 0)) best = n;
			}

			if (best) {
				if (this.nextHop !== best.id || this.hopsToGw !== best.hopsToGw + 1) {
					this.changeRole(NodeRole.RELAY, best.hopsToGw + 1, best.id, PacketType.HELLO);
				}
				this.isElecting = false;
				return;
			} else {
				// No valid path found -> I need to check if *I* should be leader
				this.runElection(config, allowedLeaders);
			}
		}
	}

	private runElection(_config: NodeConfig, allowedLeaders: number) {
		this.isElecting = true;
		const candidates = this.getSortedCandidates();
		const rulingCouncil = candidates.slice(0, allowedLeaders);
		const amICouncil = rulingCouncil.some((c) => c.id === this.id);

		if (amICouncil) {
			if (this.role !== NodeRole.LEADER) {
				this.changeRole(NodeRole.LEADER, 100, null, PacketType.ELECTION);
			}
		} else {
			const best = candidates[0];
			if (best.id !== this.id) {
				const safeHops = Math.min(best.hopsToGw + 1, 999);
				if (this.nextHop !== best.id) {
					this.changeRole(NodeRole.RELAY, safeHops, best.id, PacketType.HELLO);
				}
			}
		}
	}

	private changeRole(newRole: NodeRole, newHops: number, newNextHop: number | null, packetType: PacketType) {
		const changed = this.role !== newRole || this.hopsToGw !== newHops || this.nextHop !== newNextHop;
		this.role = newRole;
		this.hopsToGw = newHops;
		this.nextHop = newNextHop;
		if (changed) {
			this.broadcast(packetType);
			if (newRole !== NodeRole.LEADER) this.isElecting = false;
		}
	}

	private handleIsolation(dt: number) {
		if (this.role !== NodeRole.ISOLATED) {
			this.changeRole(NodeRole.ISOLATED, 999, null, PacketType.PANIC);
		}
		this.isolationTimer += dt;
	}

	private updateTimers(dt: number, config: NodeConfig) {
		for (const [id, entry] of this.neighbors) {
			entry.lastSeen += dt;
			if (entry.lastSeen > this.NEIGHBOR_TIMEOUT) {
				this.neighbors.delete(id);
				this.coopLoc.removeNeighbor(id);

				// Parent Death Trigger: FORCE STABILITY CHECK NOW
				if (this.nextHop === id) {
					this.changeRole(NodeRole.IDLE, 999, null, PacketType.PANIC);
					// This ensures we don't wait 0.5s to find a new parent
					this.ensureStability(dt, config);
				}
			}
		}

		this.helloTimer += dt;
		if (this.helloTimer >= this.HELLO_INTERVAL) {
			this.broadcast(PacketType.HELLO);
			this.helloTimer = Math.random() * 0.4 - 0.2;
		}

		this.dataTimer += dt;
		const interval = this.state === "MOVING" ? 1.5 : 5.0;
		if (this.dataTimer >= interval) {
			if (this.hopsToGw < 999) {
				this.broadcast(PacketType.DATA, { x: Math.round(this.x), y: Math.round(this.y), status: "OK" });
			}
			this.dataTimer = Math.random() * 0.5 - 0.25;
		}
	}

	private broadcast(type: PacketType, payload: any = {}) {
		this.battery = Math.max(0, this.battery - 0.05);
		const fullPayload = {
			role: this.role,
			battery: this.battery,
			hopsToGw: this.hopsToGw,
			leaderId:
				this.role === NodeRole.LEADER
					? this.id
					: this.role === NodeRole.RELAY && this.nextHop
					? this.neighbors.get(this.nextHop)?.leaderId || this.neighbors.get(this.nextHop)?.id
					: this.id,
			leaderBat:
				this.role === NodeRole.LEADER
					? this.battery
					: this.role === NodeRole.RELAY && this.nextHop
					? this.neighbors.get(this.nextHop)?.leaderBat || this.neighbors.get(this.nextHop)?.battery
					: this.battery,
			parentId: this.nextHop,
			neighborCount: this.neighbors.size,
			...payload,
		};

		this.txQueue.push({
			id: `${this.id}-${Date.now()}-${Math.random()}`,
			type,
			srcId: this.id,
			destId: type === PacketType.DATA && this.nextHop ? this.nextHop : -1,
			payload: fullPayload,
			timestamp: Date.now(),
		});
	}

	private updateMotion(dt: number, config: NodeConfig) {
		if (this.isDragging || this.state !== "MOVING") return;
		const dist = Math.sqrt(Math.pow(this.targetX - this.x, 2) + Math.pow(this.targetY - this.y, 2));
		if (dist < 10) {
			this.targetX = Math.random() * 1100 + 50;
			this.targetY = Math.random() * 700 + 50;
		} else {
			this.battery = Math.max(0, this.battery - 0.01 * dt);
			const moveStep = config.movingSpeed * 100 * dt;
			this.x += ((this.targetX - this.x) / dist) * moveStep;
			this.y += ((this.targetY - this.y) / dist) * moveStep;
		}
	}

	public toggleMode() {
		this.state = this.state === "MOVING" ? "STATIONARY" : "MOVING";
		if (this.state === "MOVING") this.dataTimer = 100;
		if (this.state === "STATIONARY") {
			this.targetX = this.x;
			this.targetY = this.y;
		}
	}

	public setGlobalPosition(lat: number, lng: number) {
		this.coopLoc.setGlobalReference(lat, lng);
	}

	public getEstimatedLocalPosition() {
		return this.coopLoc.getLocalPose();
	}

	public getLocalGraph() {
		return this.coopLoc.graph.nodes;
	}

	public getEstimatedGlobalPosition() {
		return this.coopLoc.getGlobalPosition();
	}
}
