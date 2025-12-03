import { NodeRole, NodeType, Packet, PacketType, HardwareInterface, NeighborEntry } from "../types";
import { CoopLocEngine } from "./localization/CooperativeLocalization";
import { IGlobalPosition } from "./localization/types";

export class NodeFirmware {
	public id: number;
	public type: NodeType;

	// --- Physics State (Managed by App.tsx, NOT accessed by firmware logic) ---
	public x: number;
	public y: number;
	public targetX: number;
	public targetY: number;
	public battery: number;
	// --------------------------------------------------------------------------

	// Firmware State
	public role: NodeRole;
	public state: "MOVING" | "STATIONARY";

	// Internal Logic State
	public hal: HardwareInterface;
	public coopLoc: CoopLocEngine;

	// Hysteresis State
	private stationarySince: number = 0;
	private movingSince: number = 0;
	private readonly HYSTERESIS_MS = 2000;

	// Election & Gossip State
	private helloTimer: number = 0;
	private dataTimer: number = 0;
	private rangingTimer: number = 0;
	private panicUntil: number = 0;
	private readonly HELLO_INTERVAL_MS = 1000;
	private readonly NEIGHBOR_TIMEOUT_MS = 3000;
	public hopsToGw: number = 999;

	// Sighting Queue (for backend reporting)
	public sightingQueue: { targetId: number; distance: number; timestamp: number }[] = [];
	public cloudQueue: { nodeId: number; timestamp: number; neighbors: any[]; battery: number }[] = [];

	// --- Legacy/UI State (Kept for compatibility with App.tsx visualization) ---
	public isDragging: boolean = false;
	public isGossiping: boolean = false;
	public isElecting: boolean = false;
	public isolationTimer: number = 0;
	public nextHop: number | null = null;
	public neighbors: Map<number, NeighborEntry> = new Map();
	// --------------------------------------------------------------------------

	constructor(id: number, type: NodeType, x: number, y: number, hal: HardwareInterface) {
		this.id = id;
		this.type = type;
		this.x = x;
		this.y = y;
		this.targetX = x;
		this.targetY = y;
		this.battery = 100;

		this.hal = hal;
		this.role = type === "HARDWARE_GW" ? NodeRole.ROOT : NodeRole.IDLE;
		this.state = type === "TRACKER" ? "MOVING" : "STATIONARY";
		if (this.type === "HARDWARE_GW") this.hopsToGw = 0;

		this.coopLoc = new CoopLocEngine(id);

		// Register HAL Callbacks
		this.hal.onRx = (packet) => this.handleRx(packet);
		this.hal.onTxComplete = () => this.handleTxComplete();

		// Initial random offset for blink to avoid synchronization
		this.helloTimer = this.hal.getTimeMs() + this.hal.getRandom() * 1000;
		this.dataTimer = this.hal.getTimeMs() + this.hal.getRandom() * 2000;
		this.rangingTimer = this.hal.getTimeMs() + this.hal.getRandom() * 1000;
	}

	// The main loop, called periodically by the scheduler (App.tsx)
	public tick(dt: number) {
		const now = this.hal.getTimeMs();

		// Update Isolation Timer (for UI visualization of Panic Mode)
		if (this.role === NodeRole.ISOLATED) {
			this.isolationTimer += dt;
		} else {
			this.isolationTimer = 0;
		}

		// 1. Update State Machine (Hysteresis)
		this.updateRoleState(now);

		// 2. Localization Optimization (Continuous Relaxation)
		this.coopLoc.graph.optimize(1, [this.id]);

		// 3. Application Logic (Unified Mesh Logic)
		// Even moving nodes participate in the mesh now (Mobile Ad-hoc Network)
		this.runMeshLogic(now, dt);
	}

	private updateRoleState(now: number) {
		const isMoving = this.hal.isMoving();

		if (isMoving) {
			this.movingSince = this.movingSince || now;
			this.stationarySince = 0;

			if (this.state === "STATIONARY" && now - this.movingSince > 100) {
				// Quick transition to moving
				this.state = "MOVING";
				// We do NOT reset role to IDLE anymore, allowing moving nodes to be leaders/relays
				this.hal.log(`[${this.id}] Motion detected -> MOVING (Mesh Active)`);
			}
		} else {
			this.stationarySince = this.stationarySince || now;
			this.movingSince = 0;

			if (this.state === "MOVING" && now - this.stationarySince > this.HYSTERESIS_MS) {
				// Delayed transition to stationary
				this.state = "STATIONARY";
				// If we were IDLE, we might want to become LEADER candidate, but ensureStability handles that
				this.hal.log(`[${this.id}] Stable for ${this.HYSTERESIS_MS}ms -> STATIONARY`);
			}
		}
	}

	private runMeshLogic(now: number, _dt: number) {
		// 1. Neighbor Maintenance
		this.updateNeighbors(now);

		// 2. Election / Stability
		if (this.type !== "HARDWARE_GW") {
			this.ensureStability(now);
		}

		// 3. Periodic HELLO (Discovery)
		if (now >= this.helloTimer) {
			this.broadcast(PacketType.HELLO);
			this.helloTimer = now + this.HELLO_INTERVAL_MS + (this.hal.getRandom() * 400 - 200);
		}

		// 4. Periodic DATA (Gossip)
		if (now >= this.dataTimer) {
			const neighborList = Array.from(this.neighbors.values())
				.filter((n) => n.rangeMeters !== undefined)
				.map((n) => ({
					id: n.id,
					range: n.rangeMeters,
					aoa: n.aoa,
				}));

			if (this.role === NodeRole.ROOT || this.role === NodeRole.LEADER) {
				// I am the sink (Gateway or Cluster Leader). Log my own data directly.
				this.cloudQueue.push({
					nodeId: this.id,
					timestamp: now,
					neighbors: neighborList,
					battery: this.battery,
				});
			} else if (this.hopsToGw < 999 && this.nextHop) {
				this.broadcast(PacketType.DATA, {
					type: "GOSSIP",
					originId: this.id,
					status: this.state,
					neighbors: neighborList,
					battery: this.battery,
				});
			}
			this.dataTimer = now + 5000 + this.hal.getRandom() * 1000;
		}

		// 5. Periodic Ranging (Mesh Maintenance)
		if (now >= this.rangingTimer) {
			let nextInterval = 2000 + this.hal.getRandom() * 1000; // Default: Low frequency for static mesh

			// Only STATIONARY nodes initiate ranging
			if (this.state === "STATIONARY") {
				const neighbors = Array.from(this.neighbors.values());
				if (neighbors.length > 0) {
					// Prefer ranging MOVING nodes, but fall back to any neighbor
					const movingNeighbors = neighbors.filter((n) => n.status === "MOVING");

					if (movingNeighbors.length > 0) {
						// High frequency tracking for moving nodes
						const target = movingNeighbors[Math.floor(this.hal.getRandom() * movingNeighbors.length)];
						this.initiateRanging(target.id);
						nextInterval = 250 + this.hal.getRandom() * 250; // 250-500ms (Fast tracking)
					} else {
						// Low frequency maintenance for static neighbors
						const target = neighbors[Math.floor(this.hal.getRandom() * neighbors.length)];
						this.initiateRanging(target.id);
					}
				}
			}
			this.rangingTimer = now + nextInterval;
		}
	}

	private updateNeighbors(now: number) {
		for (const [id, entry] of this.neighbors) {
			// Check timeout (using lastSeen timestamp vs now)
			// Note: entry.lastSeen should be a timestamp now, not a delta accumulator
			if (now - entry.lastSeen > this.NEIGHBOR_TIMEOUT_MS) {
				this.neighbors.delete(id);
				this.coopLoc.removeNeighbor(id);

				if (this.nextHop === id) {
					this.changeRole(NodeRole.ISOLATED, 999, null, PacketType.PANIC);
					this.panicUntil = now + 2000; // Hold-down timer to allow network to settle
				}
			}
		}
	}

	private ensureStability(now: number) {
		// 1. Isolation
		if (this.neighbors.size === 0) {
			if (this.role !== NodeRole.ISOLATED) {
				this.changeRole(NodeRole.ISOLATED, 999, null, PacketType.PANIC);
			}
			return;
		}

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
		// Hardcoded config values for now as they are not passed in
		const minClusterSize = 5;
		const maxLeaders = 1;

		if (clusterSizeEstimate >= minClusterSize) {
			allowedLeaders = maxLeaders;
		}

		const rulingCouncil = candidates.slice(0, allowedLeaders);
		const shouldBeLeader = rulingCouncil.some((c) => c.id === this.id);

		// Promotion
		if (shouldBeLeader && this.role !== NodeRole.LEADER) {
			this.runElection(allowedLeaders);
			return;
		}
		// Demotion
		if (!shouldBeLeader && this.role === NodeRole.LEADER) {
			this.runElection(allowedLeaders);
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
				this.runElection(allowedLeaders);
				return;
			}
		}

		// 5. Relay Optimization
		if (this.role === NodeRole.RELAY || this.role === NodeRole.IDLE || this.role === NodeRole.ISOLATED) {
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
				this.runElection(allowedLeaders);
			}
		}
	}

	private runElection(allowedLeaders: number) {
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

	private getSortedCandidates() {
		const candidates = [
			...Array.from(this.neighbors.values()),
			{
				id: this.id,
				role: this.role,
				battery: this.battery,
				hopsToGw: this.hopsToGw,
				neighborCount: this.neighbors.size,
				lastSeen: 0, // Irrelevant for self
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
			const aCount = (a as any).neighborCount ?? 0;
			const bCount = (b as any).neighborCount ?? 0;
			if (aCount !== bCount) return bCount - aCount;

			// 3. BATTERY
			if (a.battery !== b.battery) return b.battery - a.battery;

			// 4. ID
			return a.id - b.id;
		});
		return candidates;
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

	private broadcast(type: PacketType, payload: any = {}) {
		// Include my global position if I am calibrated
		const myGlobalPos = this.coopLoc.getGlobalPosition();

		const fullPayload = {
			role: this.role,
			battery: this.battery,
			hopsToGw: this.hopsToGw,
			leaderId:
				this.role === NodeRole.LEADER ? this.id : this.nextHop ? this.neighbors.get(this.nextHop)?.leaderId : undefined,
			parentId: this.nextHop,
			neighborCount: this.neighbors.size,
			globalPos: myGlobalPos,
			...payload,
		};

		const packet: Packet = {
			id: `${this.id}-${this.hal.getTimeMs()}-${Math.random()}`,
			type,
			srcId: this.id,
			destId: type === PacketType.DATA && this.nextHop ? this.nextHop : -1,
			payload: fullPayload,
			timestamp: this.hal.getTimeMs(),
		};
		this.hal.radioSend(packet);
	}

	private handleRx(packet: Packet) {
		const now = this.hal.getTimeMs();

		// 1. Handle Blinks (Ranging Trigger)
		if (packet.type === PacketType.HELLO && packet.payload?.type === "BLINK") {
			this.initiateRanging(packet.srcId);
		}

		// 2. Handle Ranging Response
		if (packet.type === PacketType.DATA && packet.payload?.type === "RANGING_RESPONSE") {
			this.handleRangingResponse(packet);
		}

		// 3. Handle Gossip / Data Forwarding
		if (packet.type === PacketType.DATA && packet.destId === this.id && packet.payload?.type === "GOSSIP") {
			if (this.role === NodeRole.ROOT || this.role === NodeRole.LEADER) {
				// Reached Gateway or Cluster Leader -> Add to Cloud Queue
				this.cloudQueue.push({
					nodeId: packet.payload.originId,
					timestamp: packet.timestamp,
					neighbors: packet.payload.neighbors,
					battery: packet.payload.battery,
				});
			} else if (this.nextHop) {
				// Relay -> Forward Upstream
				const fwdPacket: Packet = {
					...packet,
					id: `fwd-${this.id}-${this.hal.getTimeMs()}-${Math.random()}`,
					srcId: this.id,
					destId: this.nextHop,
					timestamp: this.hal.getTimeMs(),
				};
				this.hal.radioSend(fwdPacket);
			}
		}

		// 4. Handle Infrastructure Packets (Election/Gossip)
		if (packet.type === PacketType.HELLO || packet.type === PacketType.ELECTION || packet.type === PacketType.PANIC) {
			this.neighbors.set(packet.srcId, {
				id: packet.srcId,
				role: packet.payload.role,
				battery: packet.payload.battery,
				hopsToGw: packet.payload.hopsToGw,
				leaderId: packet.payload.leaderId,
				leaderBat: packet.payload.leaderBat,
				parentId: packet.payload.parentId,
				neighborCount: packet.payload.neighborCount,
				lastSeen: now, // Timestamp
				rssi: -50,
				status: packet.payload.status, // Capture status (MOVING/STATIONARY)
			});

			// ANCHOR PROPAGATION: If neighbor has a global position, use it to calibrate myself
			if (packet.payload.globalPos) {
				const gp = packet.payload.globalPos as IGlobalPosition;
				this.coopLoc.addExternalAnchor(packet.srcId, gp.lat, gp.lng);
			}
		}
	}

	private initiateRanging(targetId: number) {
		// In a real UWB chip, this would be a specific TWR sequence.
		// Here we simulate it by sending a "RANGING_POLL" packet.
		// The simulation engine will intercept this and provide a "RANGING_RESPONSE" with distance.

		// Simple slotting/backoff
		// We can't block, so we just send.

		const packet: Packet = {
			id: `rng-${this.id}-${targetId}-${this.hal.getTimeMs()}`,
			type: PacketType.DATA,
			srcId: this.id,
			destId: targetId,
			payload: { type: "RANGING_POLL" },
			timestamp: this.hal.getTimeMs(),
		};

		this.hal.radioSend(packet);
	}

	private handleRangingResponse(packet: Packet) {
		const dist = packet.payload.distance;
		const aoa = packet.payload.aoa;

		if (dist !== undefined) {
			this.hal.log(`[${this.id}] Ranged Node ${packet.srcId}: ${dist.toFixed(2)}m`);

			// Update Neighbor Table
			const neighbor = this.neighbors.get(packet.srcId);
			if (neighbor) {
				neighbor.rangeMeters = dist;
				neighbor.aoa = aoa;
				neighbor.lastSeen = this.hal.getTimeMs();
			}

			// Feed measurement to Localization Engine
			this.coopLoc.update(0, [
				{
					peerId: packet.srcId,
					range: dist,
					aoa: aoa,
					timestamp: this.hal.getTimeMs(),
				},
			]);

			this.sightingQueue.push({
				targetId: packet.srcId,
				distance: dist,
				timestamp: this.hal.getTimeMs(),
			});
		}
	}

	private handleTxComplete() {
		// TX Done
	}

	public toggleMode() {
		this.state = this.state === "MOVING" ? "STATIONARY" : "MOVING";
	}

	// --- Public Methods for UI/Debugging (Passthrough to CoopLoc) ---
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
