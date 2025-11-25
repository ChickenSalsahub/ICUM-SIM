import { Vector2D, Pose2D, VectorUtils } from "../math/VectorUtils";
import { IGlobalPosition, IRangeMeasurement, IOdometryMeasurement } from "./types";

/**
 * Manages the relative positions of nodes in a local coordinate frame.
 * Uses a force-directed / spring-relaxation approach to optimize the graph.
 */
export class RelativePoseGraph {
	public nodes: Map<number, Pose2D> = new Map();
	private edges: Map<string, { u: number; v: number; dist: number; weight: number }> = new Map();

	constructor(private selfId: number) {
		// Initialize self at origin
		this.nodes.set(selfId, { x: 0, y: 0, theta: 0 });
	}

	public setNodePose(id: number, pose: Pose2D) {
		this.nodes.set(id, pose);
	}

	public getNodePose(id: number): Pose2D | undefined {
		return this.nodes.get(id);
	}

	public addMeasurement(u: number, v: number, dist: number, weight: number = 1.0) {
		const key = u < v ? `${u}-${v}` : `${v}-${u}`;
		this.edges.set(key, { u, v, dist, weight });

		// Initialize node if unknown (simple heuristic placement)
		if (!this.nodes.has(u) && this.nodes.has(v)) {
			this.initializeNode(u, v, dist);
		} else if (!this.nodes.has(v) && this.nodes.has(u)) {
			this.initializeNode(v, u, dist);
		}
	}

	private initializeNode(newId: number, refId: number, dist: number) {
		const refPose = this.nodes.get(refId)!;
		// Place randomly on the circle of radius 'dist' around ref
		const angle = Math.random() * Math.PI * 2;
		this.nodes.set(newId, {
			x: refPose.x + Math.cos(angle) * dist,
			y: refPose.y + Math.sin(angle) * dist,
			theta: 0,
		});
	}

	public applyOdometry(odom: IOdometryMeasurement) {
		// When self moves, in the LOCAL frame attached to self,
		// it's equivalent to the world moving in the opposite direction.
		// OR, we can keep Self at (0,0) and shift everyone else?
		// EASIER: Update Self's pose in the graph, and let the graph relaxation
		// pull everyone else along.
		// BUT: The prompt says "Maintain a local coordinate frame".
		// Usually this means the frame is fixed to the ground (Odom frame),
		// and the robot moves within it.

		const selfPose = this.nodes.get(this.selfId);
		if (!selfPose) return;

		// Update self pose based on odometry
		// New = Old + Rotate(Delta, Old.Theta)
		const dxRot = odom.dx * Math.cos(selfPose.theta) - odom.dy * Math.sin(selfPose.theta);
		const dyRot = odom.dx * Math.sin(selfPose.theta) + odom.dy * Math.cos(selfPose.theta);

		selfPose.x += dxRot;
		selfPose.y += dyRot;
		selfPose.theta += odom.dTheta;

		this.nodes.set(this.selfId, selfPose);
	}

	public optimize(iterations: number = 10, fixedNodeIds: number[] = []) {
		const learningRate = 0.2;

		for (let i = 0; i < iterations; i++) {
			let maxError = 0;

			// Iterate over all constraints (springs)
			for (const edge of this.edges.values()) {
				const uNode = this.nodes.get(edge.u);
				const vNode = this.nodes.get(edge.v);

				if (!uNode || !vNode) continue;

				const vec = VectorUtils.sub(vNode, uNode);
				const currentDist = VectorUtils.mag(vec);

				if (currentDist === 0) continue; // Avoid division by zero

				const error = currentDist - edge.dist;
				maxError = Math.max(maxError, Math.abs(error));

				// Correction vector (spring force)
				// We want to move nodes closer/further to match edge.dist
				const correctionMag = error * learningRate * edge.weight;
				const correction = VectorUtils.scale(VectorUtils.normalize(vec), correctionMag);

				const uFixed = fixedNodeIds.includes(edge.u);
				const vFixed = fixedNodeIds.includes(edge.v);

				if (!uFixed && !vFixed) {
					// Move both towards each other
					const newU = VectorUtils.add(uNode, VectorUtils.scale(correction, 0.5));
					const newV = VectorUtils.sub(vNode, VectorUtils.scale(correction, 0.5));
					this.nodes.set(edge.u, { ...uNode, x: newU.x, y: newU.y });
					this.nodes.set(edge.v, { ...vNode, x: newV.x, y: newV.y });
				} else if (!uFixed) {
					// Move u only
					const newU = VectorUtils.add(uNode, correction);
					this.nodes.set(edge.u, { ...uNode, x: newU.x, y: newU.y });
				} else if (!vFixed) {
					// Move v only
					const newV = VectorUtils.sub(vNode, correction);
					this.nodes.set(edge.v, { ...vNode, x: newV.x, y: newV.y });
				}
			}

			// If converged, break early
			if (maxError < 0.01) break;
		}
	}
}

/**
 * Handles transformation between Local (Relative) Frame and Global (Lat/Lng) Frame.
 */
export class FrameTransformer {
	private anchors: Map<number, { local: Pose2D; global: IGlobalPosition }> = new Map();

	// Transform parameters: Global = Scale * Rotation * Local + Translation
	// We assume Scale = 1.0 (meters to meters), but Lat/Lng conversion requires projection.
	// For small areas, we can approximate Lat/Lng as a Cartesian plane.
	// 1 deg Lat ~= 111,111 meters. 1 deg Lng ~= 111,111 * cos(lat) meters.

	private originGlobal: IGlobalPosition | null = null;
	private rotation: number = 0; // radians
	private translation: Vector2D = { x: 0, y: 0 };
	private isCalibrated: boolean = false;

	public addAnchor(id: number, local: Pose2D, global: IGlobalPosition) {
		this.anchors.set(id, { local, global });
		this.recalibrate();
	}

	public localToGlobal(local: Pose2D): IGlobalPosition | null {
		if (!this.isCalibrated || !this.originGlobal) return null;

		// 1. Rotate
		const rotated = VectorUtils.rotate(local, this.rotation);

		// 2. Translate (in meters)
		const globalMetersX = rotated.x + this.translation.x;
		const globalMetersY = rotated.y + this.translation.y;

		// 3. Convert Meters -> Lat/Lng (Inverse Equirectangular approximation)
		const metersPerDegLat = 111132.92;
		const metersPerDegLng = 111412.84 * Math.cos((this.originGlobal.lat * Math.PI) / 180);

		return {
			lat: this.originGlobal.lat + globalMetersY / metersPerDegLat,
			lng: this.originGlobal.lng + globalMetersX / metersPerDegLng,
			alt: this.originGlobal.alt,
		};
	}

	private recalibrate() {
		if (this.anchors.size === 0) return;

		// Simple calibration:
		// If 1 anchor: Assume North is aligned with Y axis (Rotation = 0), align translation.
		// If 2+ anchors: Compute best fit rotation.

		const anchorList = Array.from(this.anchors.values());
		const first = anchorList[0];

		// Set origin to the first anchor's global position
		this.originGlobal = first.global;

		// Meters per degree at this latitude
		const metersPerDegLat = 111132.92;
		const metersPerDegLng = 111412.84 * Math.cos((first.global.lat * Math.PI) / 180);

		// Convert all global anchors to meters relative to originGlobal
		const points = anchorList.map((a) => {
			const dLat = a.global.lat - this.originGlobal!.lat;
			const dLng = a.global.lng - this.originGlobal!.lng;
			return {
				local: a.local,
				globalMeters: {
					x: dLng * metersPerDegLng,
					y: dLat * metersPerDegLat,
				},
			};
		});

		if (points.length === 1) {
			// 1 Anchor: Assume 0 rotation (Local Y = North)
			// Global = Local + T  => T = Global - Local
			this.rotation = 0;
			this.translation = VectorUtils.sub(points[0].globalMeters, points[0].local);
		} else {
			// 2+ Anchors: Procrustes Analysis (Rotation + Translation)
			// Simplified: Calculate centroids, then rotation.

			// 1. Centroids
			const cLocal = this.getCentroid(points.map((p) => p.local));
			const cGlobal = this.getCentroid(points.map((p) => p.globalMeters));

			// 2. Center points
			const centeredLocal = points.map((p) => VectorUtils.sub(p.local, cLocal));
			const centeredGlobal = points.map((p) => VectorUtils.sub(p.globalMeters, cGlobal));

			// 3. Compute Rotation (Kabsch algorithm simplified for 2D)
			// H = Sum(Local_i * Global_i^T)
			let H_xx = 0,
				H_xy = 0,
				H_yx = 0,
				H_yy = 0;
			for (let i = 0; i < points.length; i++) {
				H_xx += centeredLocal[i].x * centeredGlobal[i].x;
				H_xy += centeredLocal[i].x * centeredGlobal[i].y;
				H_yx += centeredLocal[i].y * centeredGlobal[i].x;
				H_yy += centeredLocal[i].y * centeredGlobal[i].y;
			}

			// Theta = atan2(H_xy - H_yx, H_xx + H_yy)
			this.rotation = Math.atan2(H_xy - H_yx, H_xx + H_yy);

			// 4. Compute Translation
			// T = cGlobal - R * cLocal
			const rotatedCLocal = VectorUtils.rotate(cLocal, this.rotation);
			this.translation = VectorUtils.sub(cGlobal, rotatedCLocal);
		}

		this.isCalibrated = true;
	}

	private getCentroid(points: Vector2D[]): Vector2D {
		const sum = points.reduce((acc, p) => VectorUtils.add(acc, p), { x: 0, y: 0 });
		return { x: sum.x / points.length, y: sum.y / points.length };
	}
}

/**
 * Main Engine for Cooperative Localization.
 */
export class CoopLocEngine {
	public graph: RelativePoseGraph;
	public transformer: FrameTransformer;
	private selfId: number;

	constructor(selfId: number) {
		this.selfId = selfId;
		this.graph = new RelativePoseGraph(selfId);
		this.transformer = new FrameTransformer();
	}

	public update(_dt: number, ranges: IRangeMeasurement[], odom?: IOdometryMeasurement) {
		// 1. Apply Odometry (Prediction Step)
		if (odom) {
			this.graph.applyOdometry(odom);
		}

		// 2. Add Range Constraints (Correction Step)
		for (const m of ranges) {
			// Add constraint between Self and Peer
			this.graph.addMeasurement(this.selfId, m.peerId, m.range);
		}

		// 3. Optimize Graph
		// We fix Self in the graph optimization if we trust odometry implicitly,
		// or if we want to keep the frame attached to Self.
		// Here we fix Self to prevent the whole world from drifting away from the origin
		// of the coordinate system arbitrarily.
		this.graph.optimize(10, [this.selfId]);
	}

	/**
	 * Call this when we receive a neighbor's neighbor list (2-hop info).
	 * This is crucial for rigid graph formation.
	 */
	public processNeighborInfo(neighborId: number, neighborNeighbors: { id: number; range: number }[]) {
		for (const nn of neighborNeighbors) {
			// Add constraint between Neighbor and Neighbor's Neighbor
			this.graph.addMeasurement(neighborId, nn.id, nn.range);
		}
	}

	public setGlobalReference(lat: number, lng: number) {
		const selfPose = this.graph.getNodePose(this.selfId);
		if (selfPose) {
			this.transformer.addAnchor(this.selfId, selfPose, { lat, lng });
		}
	}

	public addExternalAnchor(nodeId: number, lat: number, lng: number) {
		const nodePose = this.graph.getNodePose(nodeId);
		if (nodePose) {
			this.transformer.addAnchor(nodeId, nodePose, { lat, lng });
		}
	}

	public getGlobalPosition(nodeId: number = this.selfId): IGlobalPosition | null {
		const pose = this.graph.getNodePose(nodeId);
		if (!pose) return null;
		return this.transformer.localToGlobal(pose);
	}

	public getLocalPose(nodeId: number = this.selfId): Pose2D | undefined {
		return this.graph.getNodePose(nodeId);
	}
}
