export type Pt2 = { x: number; y: number };

export type CloudErrorStats = {
	mae: number;
	rmse: number;
	count: number;
};

export type CloudStructureStats = {
	abs: CloudErrorStats;
	aligned: CloudErrorStats;
	pairwiseDistMae: number;
	n: number;
	pairs: number;
};

export type CloudPositionRecord = {
	nodeId: number;
	position: Pt2;
};

type Rigid2D = { c: number; s: number; tx: number; ty: number; flipY?: boolean };

function meanPoint(points: Pt2[]): Pt2 {
	let sumX = 0;
	let sumY = 0;
	for (const p of points) {
		sumX += p.x;
		sumY += p.y;
	}
	const denom = Math.max(1, points.length);
	return { x: sumX / denom, y: sumY / denom };
}

function applyRigid2D(p: Pt2, tf: Rigid2D): Pt2 {
	const y = tf.flipY ? -p.y : p.y;
	return {
		x: tf.c * p.x - tf.s * y + tf.tx,
		y: tf.s * p.x + tf.c * y + tf.ty,
	};
}

/**
 * 2D best-fit rigid alignment (rotation+translation, no scale), optionally allowing
 * a reflection across Y (flipY) and choosing the lower SSE solution.
 */
function bestFitRigid2DAllowReflection(truth: Pt2[], est: Pt2[]): Rigid2D | undefined {
	if (truth.length !== est.length) return undefined;
	if (truth.length < 2) return undefined;

	const muT = meanPoint(truth);
	const muE = meanPoint(est);

	const solve = (flipY: boolean): Rigid2D | undefined => {
		let a = 0;
		let b = 0;
		let c0 = 0;
		let d = 0;
		for (let i = 0; i < truth.length; i++) {
			const ex = est[i].x - muE.x;
			const ey0 = est[i].y - muE.y;
			const ey = flipY ? -ey0 : ey0;
			const tx0 = truth[i].x - muT.x;
			const ty0 = truth[i].y - muT.y;
			a += ex * tx0;
			b += ex * ty0;
			c0 += ey * tx0;
			d += ey * ty0;
		}

		const denom = a + d;
		const numer = b - c0;
		if (!Number.isFinite(denom) || !Number.isFinite(numer)) return undefined;
		const theta = Math.atan2(numer, denom);
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);

		const yMu = flipY ? -muE.y : muE.y;
		const rotMuEx = cosT * muE.x - sinT * yMu;
		const rotMuEy = sinT * muE.x + cosT * yMu;
		return { c: cosT, s: sinT, tx: muT.x - rotMuEx, ty: muT.y - rotMuEy, flipY: flipY ? true : undefined };
	};

	const tfNo = solve(false);
	const tfFlip = solve(true);
	if (!tfNo) return tfFlip;
	if (!tfFlip) return tfNo;

	let sseNo = 0;
	let sseFlip = 0;
	for (let i = 0; i < truth.length; i++) {
		const aNo = applyRigid2D(est[i], tfNo);
		const dxNo = aNo.x - truth[i].x;
		const dyNo = aNo.y - truth[i].y;
		sseNo += dxNo * dxNo + dyNo * dyNo;

		const aFlip = applyRigid2D(est[i], tfFlip);
		const dxF = aFlip.x - truth[i].x;
		const dyF = aFlip.y - truth[i].y;
		sseFlip += dxF * dxF + dyF * dyF;
	}

	return sseFlip < sseNo ? tfFlip : tfNo;
}

export function computeCloudStructureStatsMeters(opts: {
	records: CloudPositionRecord[];
	truthById: Map<number, Pt2>;
}): CloudStructureStats | null {
	if (opts.records.length === 0 || opts.truthById.size === 0) return null;

	const truth: Pt2[] = [];
	const est: Pt2[] = [];
	for (const r of opts.records) {
		const t = opts.truthById.get(r.nodeId);
		if (!t) continue;
		const ex = r.position.x;
		const ey = r.position.y;
		if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
		if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
		truth.push(t);
		est.push({ x: ex, y: ey });
	}

	const n = truth.length;
	if (n === 0) return null;

	let absSum = 0;
	let absSumSq = 0;
	for (let i = 0; i < n; i++) {
		const dx = est[i].x - truth[i].x;
		const dy = est[i].y - truth[i].y;
		const e = Math.hypot(dx, dy);
		absSum += e;
		absSumSq += e * e;
	}
	const abs: CloudErrorStats = { mae: absSum / n, rmse: Math.sqrt(absSumSq / n), count: n };

	const tf = bestFitRigid2DAllowReflection(truth, est);
	let alignedSum = 0;
	let alignedSumSq = 0;
	if (tf) {
		for (let i = 0; i < n; i++) {
			const a = applyRigid2D(est[i], tf);
			const dx = a.x - truth[i].x;
			const dy = a.y - truth[i].y;
			const e = Math.hypot(dx, dy);
			alignedSum += e;
			alignedSumSq += e * e;
		}
	} else {
		alignedSum = absSum;
		alignedSumSq = absSumSq;
	}
	const aligned: CloudErrorStats = { mae: alignedSum / n, rmse: Math.sqrt(alignedSumSq / n), count: n };

	let pairSum = 0;
	let pairs = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const dt = Math.hypot(truth[i].x - truth[j].x, truth[i].y - truth[j].y);
			const de = Math.hypot(est[i].x - est[j].x, est[i].y - est[j].y);
			pairSum += Math.abs(de - dt);
			pairs++;
		}
	}
	const pairwiseDistMae = pairs > 0 ? pairSum / pairs : 0;

	return { abs, aligned, pairwiseDistMae, n, pairs };
}
