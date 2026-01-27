import { RelativePoseGraph } from "./localization/CooperativeLocalization.ts";

export interface CloudBackendOptions {
	rng?: () => number;
	mode?: "passive" | "fusion";
	// Normalization scales for residuals.
	distanceSigma?: number; // meters
	angleSigma?: number; // radians
	// Optimization budget.
	warmupIterations?: number;
	finalIterations?: number;
	pruneAgeMs?: number;
	pruneClusterAfterMs?: number; // remove nodes not seen in active cluster after this age
}

/**
 * Represents a single raw data point received from a node.
 */
export interface RawReport {
	nodeId: number;
	timestamp: number;
	x?: number; // Optional: Ground truth might not be available
	y?: number; // Optional
	estX?: number;
	estY?: number;
	lat?: number;
	lng?: number;
	battery: number;
	status?: "MOVING" | "STATIONARY";
	neighbors?: { id: number; range?: number; aoa?: number; aod?: number; tof?: number }[];
}

/**
 * Represents a fused data record stored in the cloud database.
 * This is the result of combining multiple RawReports.
 */
export interface FusedRecord {
	id: string;
	nodeId: number;
	timestamp: number; // Time of fusion
	sampleCount: number; // How many raw reports were fused
	position: {
		x: number;
		y: number;
		lat?: number;
		lng?: number;
	};
	avgBattery: number;
	status: "STABLE" | "MOVING" | "UNCERTAIN";
	neighbors: { id: number; range: number; aoa: number }[];
}

export interface CloudEvent {
	id: string;
	timestamp: number;
	level: "INFO" | "WARN" | "ERROR";
	kind: "PANIC" | "TOPOLOGY_CHANGE" | "NOTE" | "EVENT";
	nodeId?: number;
	message: string;
}

/**
 * Simulates a Cloud Backend Service.
 * Responsibilities:
 * 1. Ingest raw data from nodes (via Gateway).
 * 2. Buffer data for a short time window.
 * 3. Fuse buffered data into stable records.
 * 4. Store and serve fused records.
 */
export class CloudBackend {
	// Buffer to hold incoming reports before fusion
	private buffer: Map<number, RawReport[]> = new Map();

	// The "Database"
	private db: FusedRecord[] = [];

	// Event log (non-fusion telemetry)
	private events: CloudEvent[] = [];
	private eventCounter = 0;

	// Topology Engine (Relative Pose Graph)
	// We keep a persistent graph so the layout is continuous over time.
	// IMPORTANT: Do not assume a hardware gateway exists; seed the graph lazily.
	private graph: RelativePoseGraph | null = null;
	private graphSeedId: number | null = null;
	private readonly rng: () => number;
	private recordCounter = 0;
	private lastFusionActiveIds: Set<number> = new Set();
	private lastFusionTime = 0;
	private lastSeenByNode: Map<number, number> = new Map();
	private readonly mode: "passive" | "fusion";

	private readonly opts: Required<Omit<CloudBackendOptions, "rng" | "mode">>;

	// Configuration
	private FUSION_WINDOW_MS = 1000; // Fuse data every 1 second

	// Track how long nodes have been in the graph to avoid fixing them too early
	private nodeStabilityCounter: Map<number, number> = new Map();

	private ensureGraph(seedId: number) {
		if (!this.graph) {
			this.graph = new RelativePoseGraph(seedId, this.rng);
			this.graphSeedId = seedId;
			this.nodeStabilityCounter.clear();
		}
		return this.graph;
	}

	constructor(opts?: CloudBackendOptions) {
		this.rng = opts?.rng ?? Math.random;
		this.mode = opts?.mode ?? "passive";
		this.opts = {
			distanceSigma: opts?.distanceSigma ?? 0.15,
			angleSigma: opts?.angleSigma ?? (20 * Math.PI) / 180,
			warmupIterations: opts?.warmupIterations ?? 15,
			finalIterations: opts?.finalIterations ?? 50,
			pruneAgeMs: opts?.pruneAgeMs ?? Number.POSITIVE_INFINITY,
			pruneClusterAfterMs: opts?.pruneClusterAfterMs ?? 60_000,
		};
	}

	private pruneStaleRecords(currentTime: number) {
		if (!Number.isFinite(this.opts.pruneAgeMs)) return;
		const cutoff = currentTime - this.opts.pruneAgeMs;
		// Prune the main DB
		if (this.db.length > 0) {
			this.db = this.db.filter((r) => r.timestamp >= cutoff);
		}
	}

	private pruneStaleCluster(currentTime: number, activeNodeIds: Set<number>) {
		if (!Number.isFinite(this.opts.pruneClusterAfterMs)) return;
		if (activeNodeIds.size === 0) return;
		const cutoff = currentTime - this.opts.pruneClusterAfterMs;
		this.db = this.db.filter((r) => {
			if (activeNodeIds.has(r.nodeId)) return true;
			const lastSeen = this.lastSeenByNode.get(r.nodeId) ?? r.timestamp;
			return lastSeen >= cutoff;
		});
	}

	public recordEvent(event: Omit<CloudEvent, "id">) {
		const e: CloudEvent = {
			id: `evt-${this.eventCounter++}`,
			...event,
		};
		this.events.unshift(e);
		if (this.events.length > 500) this.events = this.events.slice(0, 500);
	}

	public recordPanic(opts: { timestamp: number; nodeId: number; message?: string }) {
		this.recordEvent({
			timestamp: opts.timestamp,
			level: "ERROR",
			kind: "PANIC",
			nodeId: opts.nodeId,
			message: opts.message ?? "PANIC",
		});

		// Immediate topology update:
		// If a node is panicking, it is likely isolated. We should reflect this in the topology
		// immediately rather than waiting for the prune timeout.
		// We inject a synthetic record with NO neighbors.
		const prev = this.db.find((r) => r.nodeId === opts.nodeId);
		let lastPos = prev?.position;
		if (!lastPos && this.mode === "fusion" && this.graph) {
			const pose = this.graph.getNodePose(opts.nodeId);
			if (pose) lastPos = { x: pose.x, y: pose.y };
		}
		if (!lastPos) {
			// Deterministic fallback to avoid overlapping isolated nodes at (0,0).
			const angle = (opts.nodeId * 137.508 * Math.PI) / 180; // golden angle
			const radius = 6 + (opts.nodeId % 5) * 2;
			lastPos = {
				x: 20 + Math.cos(angle) * radius,
				y: 15 + Math.sin(angle) * radius,
			};
		}

		const isolatedRecord: FusedRecord = {
			id: `${opts.nodeId}-panic-${this.recordCounter++}`,
			nodeId: opts.nodeId,
			timestamp: opts.timestamp,
			sampleCount: 1,
			position: lastPos,
			avgBattery: prev?.avgBattery ?? 0,
			status: "UNCERTAIN",
			neighbors: [], // Clears the edges
		};
		// Add to DB at the front
		this.db.unshift(isolatedRecord);
		if (this.db.length > 500) this.db = this.db.slice(0, 500);
	}

	public getEvents(): CloudEvent[] {
		return this.events;
	}

	/**
	 * Ingests a raw report from the network.
	 */
	public ingest(report: RawReport) {
		if (!this.buffer.has(report.nodeId)) {
			this.buffer.set(report.nodeId, []);
		}
		this.buffer.get(report.nodeId)!.push(report);
		if (Number.isFinite(report.timestamp)) {
			this.lastSeenByNode.set(report.nodeId, report.timestamp);
		}
	}

	/**
	 * Periodic processing tick.
	 * Checks if it's time to run the fusion algorithm.
	 */
	public tick(currentTime: number) {
		if (currentTime - this.lastFusionTime > this.FUSION_WINDOW_MS) {
			if (this.mode === "fusion") {
				this.runFusion();
			} else {
				this.runPassive();
			}
			this.lastFusionTime = currentTime;
			this.pruneStaleRecords(currentTime);
			if (this.mode === "fusion") {
				this.pruneStaleCluster(this.lastFusionTime, this.lastFusionActiveIds);
			}
			return true; // Indicates database updated
		}
		return false;
	}

	private runPassive() {
		if (this.buffer.size === 0) return;
		const activeNodeIds = new Set<number>();
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;
			const latest = reports[reports.length - 1];
			activeNodeIds.add(nodeId);
			let sumBat = 0;
			let sumLat = 0;
			let sumLng = 0;
			let latCount = 0;
			let lngCount = 0;
			for (const r of reports) {
				sumBat += r.battery;
				if (r.lat !== undefined) {
					sumLat += r.lat;
					latCount++;
				}
				if (r.lng !== undefined) {
					sumLng += r.lng;
					lngCount++;
				}
			}
			const prev = this.db.find((r) => r.nodeId === nodeId);
			const posX = latest.x ?? latest.estX ?? prev?.position?.x ?? 0;
			const posY = latest.y ?? latest.estY ?? prev?.position?.y ?? 0;
			const neighbors = latest.neighbors
				? latest.neighbors
						.filter((n) => Number.isFinite(n.range))
						.map((n) => ({
							id: n.id,
							range: n.range ?? 0,
							aoa: n.aoa ?? 0,
						}))
				: [];

			const record: FusedRecord = {
				id: `${nodeId}-${this.recordCounter++}`,
				nodeId,
				timestamp: latest.timestamp,
				sampleCount: reports.length,
				position: {
					x: parseFloat(posX.toFixed(2)),
					y: parseFloat(posY.toFixed(2)),
					lat: latCount > 0 ? sumLat / latCount : undefined,
					lng: lngCount > 0 ? sumLng / lngCount : undefined,
				},
				avgBattery: parseFloat((sumBat / reports.length).toFixed(1)),
				status: latest.status === "MOVING" ? "MOVING" : "STABLE",
				neighbors,
			};
			this.db.unshift(record);
		});

		this.buffer.clear();
		if (this.db.length > 500) this.db = this.db.slice(0, 500);
		this.lastFusionActiveIds = activeNodeIds;
	}

	/**
	 * THE FUSION ALGORITHM
	 *
	 * Strategy: Graph Optimization (SLAM-like)
	 *
	 * We use the RelativePoseGraph to solve for node positions based on:
	 * 1. Neighbor Ranges (Distance constraints)
	 * 2. Neighbor AoA (Angular constraints)
	 * 3. Anchor Positions (Fixed nodes like Gateways)
	 */
	private runFusion() {
		if (this.buffer.size === 0) return;

		const activeNodeIds = new Set<number>();
		const fixedNodeIds: number[] = [];
		const supernodeIds = new Set<number>();
		let fusionTime = 0;

		// 0. Identify Supernodes (Anchors)
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;
			const latest = reports[reports.length - 1];
			if (latest && Number.isFinite(latest.timestamp)) fusionTime = Math.max(fusionTime, latest.timestamp);
			activeNodeIds.add(nodeId);
			if (latest.x !== undefined && latest.y !== undefined) {
				supernodeIds.add(nodeId);
			}
		});

		// If there's no explicit anchor (e.g., no HARDWARE_GW), create a deterministic
		// virtual anchor by pinning one node in-place to fix translation.
		const hasRealAnchors = supernodeIds.size > 0;
		const seedId =
			this.graphSeedId ??
			(hasRealAnchors
				? Math.min(...Array.from(supernodeIds.values()))
				: Math.min(...Array.from(activeNodeIds.values())));
		const graph = this.ensureGraph(seedId);
		if (!hasRealAnchors) {
			const pose = graph.getNodePose(seedId);
			if (!pose) graph.setNodePose(seedId, { x: 0, y: 0, theta: 0 });
			fixedNodeIds.push(seedId);
		}

		// 1. Pre-calculate average distances AND ANGLES for bidirectional links
		const distMap = new Map<string, { val: number; weight: number }[]>();
		const angleMap = new Map<string, { x: number; y: number; weight: number }[]>();

		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;
			const latest = reports[reports.length - 1];
			if (latest.neighbors) {
				latest.neighbors.forEach((n) => {
					if (n.range) {
						const key = nodeId < n.id ? `${nodeId}-${n.id}` : `${n.id}-${nodeId}`;
						const weight = supernodeIds.has(nodeId) ? 10 : 1;

						// Distance
						if (!distMap.has(key)) distMap.set(key, []);
						distMap.get(key)!.push({ val: n.range, weight });

						// Angle (Normalize to Smaller -> Larger direction)
						if (n.aoa !== undefined) {
							if (!angleMap.has(key)) angleMap.set(key, []);
							let angle = n.aoa;
							// If we are the larger ID, our 'aoa' is Larger->Smaller.
							// We want Smaller->Larger, so add PI.
							if (nodeId > n.id) {
								angle += Math.PI;
							}
							angleMap.get(key)!.push({
								x: Math.cos(angle),
								y: Math.sin(angle),
								weight,
							});
						}
					}
				});
			}
		});

		// Build a consolidated constraint list per undirected edge.
		type EdgeConstraint = {
			key: string;
			u: number;
			v: number;
			dist: number;
			aoaUV?: number; // u->v bearing
			aoaVU?: number; // v->u bearing
			baseWeight: number;
		};
		const constraints: EdgeConstraint[] = [];
		for (const [key, dists] of distMap.entries()) {
			const [aStr, bStr] = key.split("-");
			const a = Number(aStr);
			const b = Number(bStr);
			const u = Math.min(a, b);
			const v = Math.max(a, b);

			const totalWeight = dists.reduce((sum, d) => sum + d.weight, 0);
			const weightedSum = dists.reduce((sum, d) => sum + d.val * d.weight, 0);
			const finalRange = totalWeight > 0 ? weightedSum / totalWeight : dists[dists.length - 1].val;

			let aoaUV: number | undefined;
			let aoaVU: number | undefined;
			const vecs = angleMap.get(key);
			if (vecs && vecs.length > 0) {
				let sumX = 0;
				let sumY = 0;
				let sumW = 0;
				vecs.forEach((v0) => {
					sumX += v0.x * v0.weight;
					sumY += v0.y * v0.weight;
					sumW += v0.weight;
				});
				if (sumW > 0) {
					const avgAngle = Math.atan2(sumY, sumX);
					aoaUV = avgAngle;
					aoaVU = avgAngle + Math.PI;
				}
			}

			const isSuperLink = supernodeIds.has(u) || supernodeIds.has(v);
			const baseWeight = isSuperLink ? 5.0 : 1.0;
			constraints.push({ key, u, v, dist: finalRange, aoaUV, aoaVU, baseWeight });
		}
		// 2. Process Buffers & Update Graph Nodes (poses/anchors)
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;

			const latest = reports[reports.length - 1];

			// Update Anchors (Fixed Nodes)
			// If a node reports explicit X/Y (Ground Truth), we pin it.
			if (latest.x !== undefined && latest.y !== undefined) {
				// We assume theta=0 for the anchor to fix rotation, unless we have compass data.
				// For simulation, fixing theta=0 for the Gateway is fine.
				graph.setNodePose(nodeId, { x: latest.x, y: latest.y, theta: 0 });
				fixedNodeIds.push(nodeId);
				this.nodeStabilityCounter.set(nodeId, 999); // Always stable
			} else {
				// Ensure node exists in graph even if not fixed
				if (!graph.getNodePose(nodeId)) {
					// Initialize at random position to allow physics to converge
					graph.setNodePose(nodeId, {
						x: this.rng() * 40,
						y: this.rng() * 30,
						theta: 0,
					});
					this.nodeStabilityCounter.set(nodeId, 0);
				} else {
					// Increment stability counter
					const count = this.nodeStabilityCounter.get(nodeId) || 0;
					this.nodeStabilityCounter.set(nodeId, count + 1);

					// Only apply the "fix stationary" anti-jitter heuristic when we have at least
					// one real anchor; otherwise we'd be freezing arbitrary random coordinates.
					if (hasRealAnchors && latest.status === "STATIONARY" && count > 5) {
						fixedNodeIds.push(nodeId);
					}
				}
			}
		});

		const applyConstraints = (perEdgeWeight?: Map<string, number>) => {
			// RESET GRAPH EDGES
			// We clear old constraints because the topology might have changed.
			// We only want to enforce constraints that are currently observed.
			graph.clearEdges();
			for (const c of constraints) {
				const w = c.baseWeight * (perEdgeWeight?.get(c.key) ?? 1.0);
				// Add both directional AoA constraints if available.
				graph.addMeasurement(c.u, c.v, c.dist, c.aoaUV, w);
				if (c.aoaVU !== undefined) graph.addMeasurement(c.v, c.u, c.dist, c.aoaVU, w);
			}
		};

		// 3. Optimize Graph
		applyConstraints();
		graph.optimize(this.opts.finalIterations, fixedNodeIds);

		// 4. Generate Fused Records from Graph State
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;

			const pose = graph.getNodePose(nodeId);
			if (!pose) return; // Should not happen if initialized

			// Calculate averages for other fields
			let sumBat = 0;
			let sumLat = 0;
			let sumLng = 0;
			let latCount = 0;
			let lngCount = 0;

			for (const r of reports) {
				sumBat += r.battery;
				if (r.lat !== undefined) {
					sumLat += r.lat;
					latCount++;
				}
				if (r.lng !== undefined) {
					sumLng += r.lng;
					lngCount++;
				}
			}
			const count = reports.length;

			const latestReport = reports[reports.length - 1];
			const neighbors = latestReport.neighbors
				? latestReport.neighbors
						.filter((n) => Number.isFinite(n.range))
						.map((n) => {
							// Use consensus values if available
							const key = nodeId < n.id ? `${nodeId}-${n.id}` : `${n.id}-${nodeId}`;
							let finalRange = n.range || 0;
							let finalAoA = n.aoa || 0;

							// Weighted Averaged Distance
							const dists = distMap.get(key);
							if (dists && dists.length > 0) {
								const totalWeight = dists.reduce((sum, d) => sum + d.weight, 0);
								const weightedSum = dists.reduce((sum, d) => sum + d.val * d.weight, 0);
								finalRange = weightedSum / totalWeight;
							}

							// Weighted Averaged Angle
							const vecs = angleMap.get(key);
							if (vecs && vecs.length > 0) {
								let sumX = 0;
								let sumY = 0;
								vecs.forEach((v) => {
									sumX += v.x * v.weight;
									sumY += v.y * v.weight;
								});
								const avgAngle = Math.atan2(sumY, sumX);
								if (nodeId < n.id) {
									finalAoA = avgAngle;
								} else {
									finalAoA = avgAngle + Math.PI;
								}
							}

							return {
								id: n.id,
								range: finalRange,
								aoa: finalAoA,
							};
						})
				: [];

			const record: FusedRecord = {
				id: `${nodeId}-${this.recordCounter++}`,
				nodeId,
				timestamp: latestReport.timestamp,
				sampleCount: count,
				position: {
					x: parseFloat(pose.x.toFixed(2)),
					y: parseFloat(pose.y.toFixed(2)),
					lat: latCount > 0 ? sumLat / latCount : undefined,
					lng: lngCount > 0 ? sumLng / lngCount : undefined,
				},
				avgBattery: parseFloat((sumBat / count).toFixed(1)),
				status: latestReport.status === "MOVING" ? "MOVING" : "STABLE",
				neighbors,
			};

			this.db.unshift(record);
		});

		this.buffer.clear();
		if (this.db.length > 500) this.db = this.db.slice(0, 500);
		this.lastFusionActiveIds = new Set(activeNodeIds);
		this.lastFusionTime = fusionTime || this.lastFusionTime;
	}

	public getRecords(): FusedRecord[] {
		return this.db;
	}

	public clear() {
		this.db = [];
		this.buffer.clear();
		this.graph = null;
		this.graphSeedId = null;
		this.nodeStabilityCounter.clear();
		this.events = [];
		this.eventCounter = 0;
		this.lastFusionActiveIds.clear();
		this.lastSeenByNode.clear();
	}
}
