import { Vector2D, Pose2D, VectorUtils } from "../math/VectorUtils";
import { IGlobalPosition, IRangeMeasurement, IOdometryMeasurement } from "./types";

/**
 * Manages the relative positions of nodes in a local coordinate frame.
 * Uses a force-directed / spring-relaxation approach to optimize the graph.
 */
export class RelativePoseGraph {
	public nodes: Map<number, Pose2D> = new Map();
	private edges: Map<string, { u: number; v: number; dist: number; weight: number; aoaUV?: number; aoaVU?: number }> =
		new Map();

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

	public addMeasurement(u: number, v: number, dist: number, aoa?: number, weight: number = 1.0) {
		const key = u < v ? `${u}-${v}` : `${v}-${u}`;
		const existing = this.edges.get(key);

		let aoaUV = existing?.aoaUV;
		let aoaVU = existing?.aoaVU;

		if (aoa !== undefined) {
			if (u < v) aoaUV = aoa;
			else aoaVU = aoa;
		}

		this.edges.set(key, { u: u < v ? u : v, v: u < v ? v : u, dist, weight, aoaUV, aoaVU });

		// Initialize node if unknown (simple heuristic placement)
		if (!this.nodes.has(u) && this.nodes.has(v)) {
			this.initializeNode(u, v, dist, aoa);
		} else if (!this.nodes.has(v) && this.nodes.has(u)) {
			this.initializeNode(v, u, dist, aoa);
		}
	}

	private initializeNode(newId: number, refId: number, dist: number, aoa?: number) {
		const refPose = this.nodes.get(refId)!;
		let angle = Math.random() * Math.PI * 2;

		if (aoa !== undefined) {
			angle = refPose.theta + aoa;
		}

		this.nodes.set(newId, {
			x: refPose.x + Math.cos(angle) * dist,
			y: refPose.y + Math.sin(angle) * dist,
			theta: 0,
		});
	}

	public applyOdometry(odom: IOdometryMeasurement) {
		const selfPose = this.nodes.get(this.selfId);
		if (!selfPose) return;

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

			for (const edge of this.edges.values()) {
				const uNode = this.nodes.get(edge.u);
				const vNode = this.nodes.get(edge.v);

				if (!uNode || !vNode) continue;

				const vec = VectorUtils.sub(vNode, uNode);
				const currentDist = VectorUtils.mag(vec);

				if (currentDist === 0) continue;

				// 1. Distance Constraint
				const distError = currentDist - edge.dist;
				maxError = Math.max(maxError, Math.abs(distError));

				const distCorrectionMag = distError * learningRate * edge.weight;
				const distCorrection = VectorUtils.scale(VectorUtils.normalize(vec), distCorrectionMag);

				// 2. Angular Constraint (AoA)
				let angularCorrectionU = { x: 0, y: 0 };
				let angularCorrectionV = { x: 0, y: 0 };

				if (edge.aoaUV !== undefined) {
					const targetAngle = uNode.theta + edge.aoaUV;
					const currentAngle = Math.atan2(vec.y, vec.x);
					let angleDiff = targetAngle - currentAngle;
					while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
					while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

					const perp = { x: -vec.y, y: vec.x };
					const perpNorm = VectorUtils.normalize(perp);
					const arcLen = currentDist * angleDiff * learningRate * 0.5;

					angularCorrectionV = VectorUtils.add(angularCorrectionV, VectorUtils.scale(perpNorm, arcLen));
				}

				if (edge.aoaVU !== undefined) {
					const targetAngle = vNode.theta + edge.aoaVU;
					const currentAngle = Math.atan2(-vec.y, -vec.x);
					let angleDiff = targetAngle - currentAngle;
					while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
					while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

					const perp = { x: vec.y, y: -vec.x };
					const perpNorm = VectorUtils.normalize(perp);
					const arcLen = currentDist * angleDiff * learningRate * 0.5;

					angularCorrectionU = VectorUtils.add(angularCorrectionU, VectorUtils.scale(perpNorm, arcLen));
				}

				const uFixed = fixedNodeIds.includes(edge.u);
				const vFixed = fixedNodeIds.includes(edge.v);

				if (!uFixed && !vFixed) {
					const newU_dist = VectorUtils.add(uNode, VectorUtils.scale(distCorrection, 0.5));
					const newV_dist = VectorUtils.sub(vNode, VectorUtils.scale(distCorrection, 0.5));

					const newU = VectorUtils.add(newU_dist, angularCorrectionU);
					const newV = VectorUtils.add(newV_dist, angularCorrectionV);

					this.nodes.set(edge.u, { ...uNode, x: newU.x, y: newU.y });
					this.nodes.set(edge.v, { ...vNode, x: newV.x, y: newV.y });
				} else if (!uFixed) {
					const newU_dist = VectorUtils.add(uNode, distCorrection);
					const newU = VectorUtils.add(newU_dist, angularCorrectionU);
					this.nodes.set(edge.u, { ...uNode, x: newU.x, y: newU.y });
				} else if (!vFixed) {
					const newV_dist = VectorUtils.sub(vNode, distCorrection);
					const newV = VectorUtils.add(newV_dist, angularCorrectionV);
					this.nodes.set(edge.v, { ...vNode, x: newV.x, y: newV.y });
				}
			}

			if (maxError < 0.01) break;
		}
	}

	public removeNode(id: number) {
		this.nodes.delete(id);
		// Remove all edges connected to this node
		for (const key of this.edges.keys()) {
			const [uStr, vStr] = key.split("-");
			const u = parseInt(uStr);
			const v = parseInt(vStr);
			if (u === id || v === id) {
				this.edges.delete(key);
			}
		}
	}

	public clearEdges() {
		this.edges.clear();
	}
}

/**
 * Handles transformation between Local (Relative) Frame and Global (Lat/Lng) Frame.
 */
export class FrameTransformer {
	private anchors: Map<number, { local: Pose2D; global: IGlobalPosition }> = new Map();
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

		const rotated = VectorUtils.rotate(local, this.rotation);
		const globalMetersX = rotated.x + this.translation.x;
		const globalMetersY = rotated.y + this.translation.y;

		const metersPerDegLat = 111132.92;
		const metersPerDegLng = 111412.84 * Math.cos((this.originGlobal.lat * Math.PI) / 180);

		return {
			lat: this.originGlobal.lat + globalMetersY / metersPerDegLat,
			lng: this.originGlobal.lng + globalMetersX / metersPerDegLng,
			alt: this.originGlobal.alt,
		};
	}

	public getGlobalOrigin(): IGlobalPosition | null {
		return this.originGlobal;
	}

	private recalibrate() {
		if (this.anchors.size === 0) return;

		const anchorList = Array.from(this.anchors.values());
		const first = anchorList[0];
		this.originGlobal = first.global;

		const metersPerDegLat = 111132.92;
		const metersPerDegLng = 111412.84 * Math.cos((first.global.lat * Math.PI) / 180);

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
			this.rotation = 0;
			this.translation = VectorUtils.sub(points[0].globalMeters, points[0].local);
		} else {
			const cLocal = this.getCentroid(points.map((p) => p.local));
			const cGlobal = this.getCentroid(points.map((p) => p.globalMeters));

			const centeredLocal = points.map((p) => VectorUtils.sub(p.local, cLocal));
			const centeredGlobal = points.map((p) => VectorUtils.sub(p.globalMeters, cGlobal));

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

			this.rotation = Math.atan2(H_xy - H_yx, H_xx + H_yy);
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
		if (odom) {
			this.graph.applyOdometry(odom);
		}

		for (const m of ranges) {
			this.graph.addMeasurement(this.selfId, m.peerId, m.range, m.aoa);
		}

		this.graph.optimize(10, [this.selfId]);
	}

	public processNeighborInfo(neighborId: number, neighborNeighbors: { id: number; range: number }[]) {
		for (const nn of neighborNeighbors) {
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

	public getGlobalOrigin(): IGlobalPosition | null {
		return this.transformer.getGlobalOrigin();
	}

	public getGlobalPosition(nodeId: number = this.selfId): IGlobalPosition | null {
		const pose = this.graph.getNodePose(nodeId);
		if (!pose) return null;
		return this.transformer.localToGlobal(pose);
	}

	public getLocalPose(nodeId: number = this.selfId): Pose2D | undefined {
		return this.graph.getNodePose(nodeId);
	}

	public removeNeighbor(neighborId: number) {
		this.graph.removeNode(neighborId);
	}
}
