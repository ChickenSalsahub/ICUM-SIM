import type { RunnerSnapshot } from "./types.ts";

/**
 * Sum of transmitted packets across all nodes.
 *
 * This is the main "energy proxy" used in the paper-style plots.
 */
export function sumTx(nodes: RunnerSnapshot["nodes"]) {
	return nodes.reduce((sum, node) => sum + node.txCount, 0);
}

/**
 * Root-mean-squared position error over all nodes.
 */
export function rmse(nodes: RunnerSnapshot["nodes"]) {
	let sum = 0;
	for (const node of nodes) {
		const est = node.firmware.estPosition;
		const err = Math.sqrt((est.x - node.trueX) ** 2 + (est.y - node.trueY) ** 2);
		sum += err * err;
	}
	return Math.sqrt(sum / nodes.length);
}

/**
 * Mean absolute position error over all nodes.
 */
export function mae(nodes: RunnerSnapshot["nodes"]) {
	let sum = 0;
	for (const node of nodes) {
		const est = node.firmware.estPosition;
		const err = Math.sqrt((est.x - node.trueX) ** 2 + (est.y - node.trueY) ** 2);
		sum += err;
	}
	return sum / nodes.length;
}

/**
 * Average localization error (ALE).
 *
 * In this simulator this is identical to MAE, but we keep the name to match
 * the experiment definitions and CSV headers.
 */
export function ale(nodes: RunnerSnapshot["nodes"]) {
	return mae(nodes);
}


export type Pt = { x: number; y: number };

function meanPoint(points: Pt[]): Pt {
	let sumX = 0;
	let sumY = 0;
	for (const p of points) {
		sumX += p.x;
		sumY += p.y;
	}
	const denom = Math.max(1, points.length);
	return { x: sumX / denom, y: sumY / denom };
}

/**
 * Computes the best-fit 2D rigid transform (rotation + translation, no scaling)
 * that aligns `est` onto `truth` (Kabsch in 2D).
 *
 * This matters because cooperative localization without anchors is only
 * identifiable up to a global rotation/translation. Measuring raw absolute
 * error can look "stuck" even when the relative geometry has converged.
 */
export type Rigid2D = { c: number; s: number; tx: number; ty: number; flipY?: boolean };

export function bestFitRigid2D(truth: Pt[], est: Pt[]): Rigid2D | undefined {
	if (truth.length !== est.length) return undefined;
	if (truth.length < 2) return undefined;

	const muT = meanPoint(truth);
	const muE = meanPoint(est);

	const solve = (flipY: boolean): Rigid2D | undefined => {
		// Covariance H = E^T * T (with centered coordinates).
		let a = 0;
		let b = 0;
		let c0 = 0;
		let d = 0;
		for (let i = 0; i < truth.length; i++) {
			const ex = est[i].x - muE.x;
			const ey0 = est[i].y - muE.y;
			const ey = flipY ? -ey0 : ey0;
			const tx = truth[i].x - muT.x;
			const ty = truth[i].y - muT.y;
			a += ex * tx;
			b += ex * ty;
			c0 += ey * tx;
			d += ey * ty;
		}

		// For 2D Kabsch, optimal rotation angle is:
		// theta = atan2(b - c, a + d)
		const denom = a + d;
		const numer = b - c0;
		if (!Number.isFinite(denom) || !Number.isFinite(numer)) return undefined;
		const theta = Math.atan2(numer, denom);
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);

		// Translation: muT - R * muE (with optional reflection)
		const yMu = flipY ? -muE.y : muE.y;
		const rotMuEx = cosT * muE.x - sinT * yMu;
		const rotMuEy = sinT * muE.x + cosT * yMu;
		return { c: cosT, s: sinT, tx: muT.x - rotMuEx, ty: muT.y - rotMuEy, flipY: flipY ? true : undefined };
	};

	const tfNo = solve(false);
	const tfFlip = solve(true);
	if (!tfNo) return tfFlip;
	if (!tfFlip) return tfNo;

	const apply = (p: Pt, tf: Rigid2D): Pt => {
		const y = tf.flipY ? -p.y : p.y;
		return { x: tf.c * p.x - tf.s * y + tf.tx, y: tf.s * p.x + tf.c * y + tf.ty };
	};
	let sseNo = 0;
	let sseFlip = 0;
	for (let i = 0; i < truth.length; i++) {
		const aNo = apply(est[i], tfNo);
		const dxNo = aNo.x - truth[i].x;
		const dyNo = aNo.y - truth[i].y;
		sseNo += dxNo * dxNo + dyNo * dyNo;

		const aFlip = apply(est[i], tfFlip);
		const dxF = aFlip.x - truth[i].x;
		const dyF = aFlip.y - truth[i].y;
		sseFlip += dxF * dxF + dyF * dyF;
	}
	return sseFlip < sseNo ? tfFlip : tfNo;
}

export function applyRigid2D(p: Pt, tf: Rigid2D): Pt {
	const y = tf.flipY ? -p.y : p.y;
	return {
		x: tf.c * p.x - tf.s * y + tf.tx,
		y: tf.s * p.x + tf.c * y + tf.ty,
	};
}

/**
 * Anchor-free ALE: aligns estimated positions to truth before scoring.
 */
export function aleAlignedRigid(nodes: RunnerSnapshot["nodes"]) {
	const nodeIds: number[] = [];
	const truth: Pt[] = [];
	const est: Pt[] = [];
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		nodeIds.push(node.id);
		truth.push({ x: node.trueX, y: node.trueY });
		est.push({ x: p.x, y: p.y });
	}

	const idToIndex = new Map<number, number>();
	for (let i = 0; i < nodeIds.length; i++) idToIndex.set(nodeIds[i], i);

	const adjacency: number[][] = Array.from({ length: nodes.length }, () => []);
	let edgeCount = 0;
	for (const node of nodes) {
		const i = idToIndex.get(node.id);
		if (i === undefined) continue;
		for (const nb of node.firmware.neighbors) {
			const j = idToIndex.get(nb.id);
			if (j === undefined || j === i) continue;
			adjacency[i].push(j);
			// Treat as undirected.
			adjacency[j].push(i);
			edgeCount++;
		}
	}

	const components: number[][] = [];
	if (edgeCount === 0) {
		components.push(Array.from({ length: nodes.length }, (_, i) => i));
	} else {
		const visited = new Array<boolean>(nodes.length).fill(false);
		for (let i = 0; i < nodes.length; i++) {
			if (visited[i]) continue;
			const comp: number[] = [];
			const stack = [i];
			visited[i] = true;
			while (stack.length > 0) {
				const cur = stack.pop()!;
				comp.push(cur);
				for (const nb of adjacency[cur]) {
					if (visited[nb]) continue;
					visited[nb] = true;
					stack.push(nb);
				}
			}
			components.push(comp);
		}
	}

	let sum = 0;
	for (const comp of components) {
		if (comp.length < 2) {
			const i = comp[0];
			if (i === undefined) continue;
			const dx = est[i].x - truth[i].x;
			const dy = est[i].y - truth[i].y;
			sum += Math.hypot(dx, dy);
			continue;
		}

		const truthC = comp.map((i) => truth[i]);
		const estC = comp.map((i) => est[i]);
		const tf = bestFitRigid2D(truthC, estC);
		if (!tf) {
			for (const i of comp) {
				const dx = est[i].x - truth[i].x;
				const dy = est[i].y - truth[i].y;
				sum += Math.hypot(dx, dy);
			}
			continue;
		}

		for (const i of comp) {
			const aligned = applyRigid2D(est[i], tf);
			const dx = aligned.x - truth[i].x;
			const dy = aligned.y - truth[i].y;
			sum += Math.hypot(dx, dy);
		}
	}
	return sum / nodes.length;
}

/**
 * Anchor-free RMSE: rigidly aligns estimated positions to truth before scoring.
 */
export function rmseAlignedRigid(nodes: RunnerSnapshot["nodes"]) {
	const nodeIds: number[] = [];
	const truth: Pt[] = [];
	const est: Pt[] = [];
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		nodeIds.push(node.id);
		truth.push({ x: node.trueX, y: node.trueY });
		est.push({ x: p.x, y: p.y });
	}

	const idToIndex = new Map<number, number>();
	for (let i = 0; i < nodeIds.length; i++) idToIndex.set(nodeIds[i], i);

	const adjacency: number[][] = Array.from({ length: nodes.length }, () => []);
	let edgeCount = 0;
	for (const node of nodes) {
		const i = idToIndex.get(node.id);
		if (i === undefined) continue;
		for (const nb of node.firmware.neighbors) {
			const j = idToIndex.get(nb.id);
			if (j === undefined || j === i) continue;
			adjacency[i].push(j);
			adjacency[j].push(i);
			edgeCount++;
		}
	}

	const components: number[][] = [];
	if (edgeCount === 0) {
		components.push(Array.from({ length: nodes.length }, (_, i) => i));
	} else {
		const visited = new Array<boolean>(nodes.length).fill(false);
		for (let i = 0; i < nodes.length; i++) {
			if (visited[i]) continue;
			const comp: number[] = [];
			const stack = [i];
			visited[i] = true;
			while (stack.length > 0) {
				const cur = stack.pop()!;
				comp.push(cur);
				for (const nb of adjacency[cur]) {
					if (visited[nb]) continue;
					visited[nb] = true;
					stack.push(nb);
				}
			}
			components.push(comp);
		}
	}

	let sumSq = 0;
	for (const comp of components) {
		if (comp.length < 2) {
			const i = comp[0];
			if (i === undefined) continue;
			const dx = est[i].x - truth[i].x;
			const dy = est[i].y - truth[i].y;
			sumSq += dx * dx + dy * dy;
			continue;
		}

		const truthC = comp.map((i) => truth[i]);
		const estC = comp.map((i) => est[i]);
		const tf = bestFitRigid2D(truthC, estC);
		if (!tf) {
			for (const i of comp) {
				const dx = est[i].x - truth[i].x;
				const dy = est[i].y - truth[i].y;
				sumSq += dx * dx + dy * dy;
			}
			continue;
		}

		for (const i of comp) {
			const aligned = applyRigid2D(est[i], tf);
			const dx = aligned.x - truth[i].x;
			const dy = aligned.y - truth[i].y;
			sumSq += dx * dx + dy * dy;
		}
	}
	return Math.sqrt(sumSq / nodes.length);
}

/**
 * Structure error: mean absolute error of pairwise distances (meters).
 *
 * This is rigid-transform invariant, so it remains meaningful without anchors.
 */
export function pairwiseDistanceMae(nodes: RunnerSnapshot["nodes"]) {
	const truth: Pt[] = [];
	const est: Pt[] = [];
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		truth.push({ x: node.trueX, y: node.trueY });
		est.push({ x: p.x, y: p.y });
	}
	const n = truth.length;
	if (n < 2) return 0;

	let sum = 0;
	let pairs = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const dt = Math.hypot(truth[i].x - truth[j].x, truth[i].y - truth[j].y);
			const de = Math.hypot(est[i].x - est[j].x, est[i].y - est[j].y);
			sum += Math.abs(de - dt);
			pairs++;
		}
	}
	return pairs > 0 ? sum / pairs : 0;
}

function wrapAngleRad(angleRad: number): number {
	// Normalize to [-pi, pi).
	let a = (angleRad + Math.PI) % (2 * Math.PI);
	if (a < 0) a += 2 * Math.PI;
	return a - Math.PI;
}

/**
 * Deployable, anchor-free range residual MAE (meters).
 *
 * For each observed neighbor edge (deduplicated as undirected), compute:
 *   | ||p_i - p_j|| - r_ij |
 * where p_i are estimated positions and r_ij is the measured UWB range.
 *
 * Returns NaN if no valid edges exist.
 */
export function measurementRangeResidualMae(nodes: RunnerSnapshot["nodes"]) {
	const estById = new Map<number, Pt>();
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		estById.set(node.id, { x: p.x, y: p.y });
	}

	const seen = new Set<string>();
	let sum = 0;
	let count = 0;
	for (const node of nodes) {
		const pi = estById.get(node.id);
		if (!pi) continue;
		for (const obs of node.firmware.neighbors) {
			const pj = estById.get(obs.id);
			if (!pj) continue;
			if (!Number.isFinite(obs.rangeMeters)) continue;
			const a = Math.min(node.id, obs.id);
			const b = Math.max(node.id, obs.id);
			const key = `${a}-${b}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const pred = Math.hypot(pj.x - pi.x, pj.y - pi.y);
			if (!Number.isFinite(pred)) continue;
			sum += Math.abs(pred - obs.rangeMeters);
			count++;
		}
	}

	return count > 0 ? sum / count : Number.NaN;
}

/**
 * Deployable, anchor-free bearing/AoA residual MAE (radians).
 *
 * For each directed neighbor observation that includes `angleRad`, compute:
 *   |wrap( bearing(p_i -> p_j) - angle_ij )|
 *
 * Returns NaN if no valid angles exist.
 */
export function measurementAngleResidualMae(nodes: RunnerSnapshot["nodes"]) {
	const estById = new Map<number, Pt>();
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		estById.set(node.id, { x: p.x, y: p.y });
	}

	let sum = 0;
	let count = 0;
	for (const node of nodes) {
		const pi = estById.get(node.id);
		if (!pi) continue;
		for (const obs of node.firmware.neighbors) {
			if (obs.angleRad === undefined) continue;
			if (!Number.isFinite(obs.angleRad)) continue;
			const pj = estById.get(obs.id);
			if (!pj) continue;
			const pred = Math.atan2(pj.y - pi.y, pj.x - pi.x);
			const err = wrapAngleRad(pred - obs.angleRad);
			sum += Math.abs(err);
			count++;
		}
	}

	return count > 0 ? sum / count : Number.NaN;
}
