import { RelativePoseGraph } from "./localization/CooperativeLocalization";

/**
 * Represents a single raw data point received from a node.
 */
export interface RawReport {
	nodeId: number;
	timestamp: number;
	x?: number; // Optional: Ground truth might not be available
	y?: number; // Optional
	lat?: number;
	lng?: number;
	battery: number;
	neighbors?: { id: number; range?: number; aoa?: number }[];
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

	// Topology Engine (Relative Pose Graph)
	// We use a persistent graph to track the network topology over time.
	// This allows us to use "distance" and "angles" (AoA) to reconstruct the layout.
	private graph: RelativePoseGraph = new RelativePoseGraph(1); // Initialize with ID 1 (Gateway)

	// Configuration
	private FUSION_WINDOW_MS = 1000; // Fuse data every 1 second
	private lastFusionTime = 0;

	/**
	 * Ingests a raw report from the network.
	 */
	public ingest(report: RawReport) {
		if (!this.buffer.has(report.nodeId)) {
			this.buffer.set(report.nodeId, []);
		}
		this.buffer.get(report.nodeId)!.push(report);
	}

	/**
	 * Periodic processing tick.
	 * Checks if it's time to run the fusion algorithm.
	 */
	public tick(currentTime: number) {
		if (currentTime - this.lastFusionTime > this.FUSION_WINDOW_MS) {
			this.runFusion();
			this.lastFusionTime = currentTime;
			return true; // Indicates database updated
		}
		return false;
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
		const activeNodeIds = new Set<number>();
		const fixedNodeIds: number[] = [];

		// 1. Process Buffers & Update Graph Constraints
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;
			activeNodeIds.add(nodeId);

			const latest = reports[reports.length - 1];

			// Update Edges (Measurements)
			if (latest.neighbors) {
				latest.neighbors.forEach((n) => {
					if (n.range) {
						// Add measurement to the graph: u, v, dist, aoa
						// Note: range is in meters. We convert to pixels for visualization (x20)
						// OR we keep it in meters and scale the view?
						// The RelativePoseGraph works in arbitrary units.
						// Let's use PIXELS to match the simulation view (20px = 1m)
						const distPx = n.range * 20;
						this.graph.addMeasurement(nodeId, n.id, distPx, n.aoa);
					}
				});
			}

			// Update Anchors (Fixed Nodes)
			// If a node reports explicit X/Y (Ground Truth), we pin it.
			if (latest.x !== undefined && latest.y !== undefined) {
				// We assume theta=0 for the anchor to fix rotation, unless we have compass data.
				// For simulation, fixing theta=0 for the Gateway is fine.
				this.graph.setNodePose(nodeId, { x: latest.x, y: latest.y, theta: 0 });
				fixedNodeIds.push(nodeId);
			} else {
				// Ensure node exists in graph even if not fixed
				if (!this.graph.getNodePose(nodeId)) {
					// Initialize at random position to allow physics to converge
					this.graph.setNodePose(nodeId, {
						x: Math.random() * 800,
						y: Math.random() * 600,
						theta: 0,
					});
				}
			}
		});

		// 2. Optimize Graph
		// Run a few iterations to relax the spring system
		this.graph.optimize(50, fixedNodeIds);

		// 3. Generate Fused Records from Graph State
		this.buffer.forEach((reports, nodeId) => {
			if (reports.length === 0) return;

			const pose = this.graph.getNodePose(nodeId);
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
				? latestReport.neighbors.map((n) => ({
						id: n.id,
						range: n.range || 0,
						aoa: n.aoa || 0,
				  }))
				: [];

			const record: FusedRecord = {
				id: Math.random().toString(36).substr(2, 9),
				nodeId,
				timestamp: Date.now(),
				sampleCount: count,
				position: {
					x: Math.round(pose.x),
					y: Math.round(pose.y),
					lat: latCount > 0 ? sumLat / latCount : undefined,
					lng: lngCount > 0 ? sumLng / lngCount : undefined,
				},
				avgBattery: parseFloat((sumBat / count).toFixed(1)),
				status: "STABLE",
				neighbors,
			};

			this.db.unshift(record);
		});

		this.buffer.clear();
		if (this.db.length > 500) this.db = this.db.slice(0, 500);
	}

	public getRecords(): FusedRecord[] {
		return this.db;
	}

	public clear() {
		this.db = [];
		this.buffer.clear();
		// We might want to clear the graph too, or keep it for continuity?
		// Let's clear it to fully reset.
		this.graph = new RelativePoseGraph(1);
	}
}
