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

type Pt = { x: number; y: number };

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
function bestFitRigid2D(truth: Pt[], est: Pt[]): { c: number; s: number; tx: number; ty: number } | undefined {
	if (truth.length !== est.length) return undefined;
	if (truth.length < 2) return undefined;

	const muT = meanPoint(truth);
	const muE = meanPoint(est);

	// Covariance H = E^T * T (with centered coordinates).
	let a = 0;
	let b = 0;
	let c = 0;
	let d = 0;
	for (let i = 0; i < truth.length; i++) {
		const ex = est[i].x - muE.x;
		const ey = est[i].y - muE.y;
		const tx = truth[i].x - muT.x;
		const ty = truth[i].y - muT.y;
		a += ex * tx;
		b += ex * ty;
		c += ey * tx;
		d += ey * ty;
	}

	// For 2D Kabsch, optimal rotation angle is:
	// theta = atan2(b - c, a + d)
	const denom = a + d;
	const numer = b - c;
	if (!Number.isFinite(denom) || !Number.isFinite(numer)) return undefined;
	const theta = Math.atan2(numer, denom);
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);

	// Translation: muT - R * muE
	const rotMuEx = cosT * muE.x - sinT * muE.y;
	const rotMuEy = sinT * muE.x + cosT * muE.y;
	return { c: cosT, s: sinT, tx: muT.x - rotMuEx, ty: muT.y - rotMuEy };
}

function applyRigid2D(p: Pt, tf: { c: number; s: number; tx: number; ty: number }): Pt {
	return {
		x: tf.c * p.x - tf.s * p.y + tf.tx,
		y: tf.s * p.x + tf.c * p.y + tf.ty,
	};
}

/**
 * Anchor-free ALE: aligns estimated positions to truth before scoring.
 */
export function aleAlignedRigid(nodes: RunnerSnapshot["nodes"]) {
	const truth: Pt[] = [];
	const est: Pt[] = [];
	for (const node of nodes) {
		const p = node.firmware.estPosition;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Number.NaN;
		truth.push({ x: node.trueX, y: node.trueY });
		est.push({ x: p.x, y: p.y });
	}

	const tf = bestFitRigid2D(truth, est);
	if (!tf) {
		// Fallback to raw ALE (mainly for tiny N).
		return ale(nodes);
	}

	let sum = 0;
	for (let i = 0; i < nodes.length; i++) {
		const aligned = applyRigid2D(est[i], tf);
		const dx = aligned.x - truth[i].x;
		const dy = aligned.y - truth[i].y;
		sum += Math.sqrt(dx * dx + dy * dy);
	}
	return sum / nodes.length;
}
