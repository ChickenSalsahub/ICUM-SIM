import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { RelativePoseGraph } from "../../logic/localization/CooperativeLocalization.ts";
import { aleAlignedRigid, mae, pairwiseDistanceMae, rmse, rmseAlignedRigid } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentBRow {
	nodeCount: number;
	noiseSigma: number;
	rmse: number;
	mae: number;
	rmseAligned: number;
	maeAligned: number;
	pairwiseDistMae: number;
}

export interface ExperimentBRowRaw extends ExperimentBRow {
	seed: number;
}

type EstNode = {
	id: number;
	x: number;
	y: number;
	firmware: { estPosition: { x: number; y: number }; neighbors: any[] };
	txCount: number;
};

function buildEstimatedNodesFromPoseGraph(
	snapshot: ReturnType<SimulationRunner["snapshot"]>,
	graph: RelativePoseGraph,
): EstNode[] {
	return snapshot.nodes.map((n) => {
		const pose = graph.getNodePose(n.id);
		const estX = pose?.x ?? 0;
		const estY = pose?.y ?? 0;
		return {
			id: n.id,
			x: n.x,
			y: n.y,
			firmware: { ...n.firmware, estPosition: { x: estX, y: estY } },
			txCount: n.txCount,
		};
	});
}

function solvePoseGraphFromRanging(opts: {
	seed: number;
	nodeLayout: { id: number; x: number; y: number }[];
	simSeconds: number;
	uwbNoiseSigma: number;
}) {
	const runner = new SimulationRunner({
		seed: opts.seed,
		uwbNoiseSigma: opts.uwbNoiseSigma,
		// Make the sweep about *range noise* (not loss / AoA noise / connectivity artifacts).
		packetLoss: 0,
		uwbAngleNoiseStdRad: 0,
		uwbRangeMeters: 200,
		worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
	});
	seedNodes(runner, opts.nodeLayout);

	const graph = new RelativePoseGraph(1, seededRng(opts.seed + 999));

	// Capture measured range+bearing as delivered to each receiver.
	// SimulationRunner injects:
	//  - payload.range: measured distance (meters)
	//  - payload.angle: bearing from self(receiver) -> neighbor(sender) in radians
	// That matches the expected semantics for RelativePoseGraph.addMeasurement(u=self, v=neighbor, dist, aoa).
	runner.setHooks({
		onDeliver: (evt) => {
			const payload = evt.packet.payload;
			const dist = payload?.range;
			const aoa = payload?.angle;
			if (!Number.isFinite(dist) || dist <= 0) return;
			if (!Number.isFinite(aoa)) return;
			graph.addMeasurement(evt.recipientId, evt.senderId, dist, aoa, 1.0);
		},
	});

	runner.runFor(opts.simSeconds);

	// Run a stronger optimization pass since this is a final-score experiment.
	graph.optimize(400);

	const snapshot = runner.snapshot();
	const estNodes = buildEstimatedNodesFromPoseGraph(snapshot, graph);
	return { snapshot, estNodes };
}

function sortedFinite(values: number[]): number[] {
	return values
		.filter((v) => Number.isFinite(v))
		.slice()
		.sort((a, b) => a - b);
}

function quantileSorted(xs: number[], q: number): number {
	if (xs.length === 0) return Number.NaN;
	if (q <= 0) return xs[0];
	if (q >= 1) return xs[xs.length - 1];
	const pos = (xs.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return xs[lo];
	const t = pos - lo;
	return xs[lo] * (1 - t) + xs[hi] * t;
}

function median(values: number[]): number {
	const xs = sortedFinite(values);
	return quantileSorted(xs, 0.5);
}

function mean(values: number[]): number {
	const xs = values.filter((v) => Number.isFinite(v));
	if (xs.length === 0) return Number.NaN;
	return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stddev(values: number[], mu: number): number {
	const xs = values.filter((v) => Number.isFinite(v));
	if (xs.length < 2) return Number.NaN;
	const v = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
	return Math.sqrt(v);
}

function ci95(values: number[]): { lo: number; hi: number } {
	const xs = values.filter((v) => Number.isFinite(v));
	const mu = mean(xs);
	const sd = stddev(xs, mu);
	if (!Number.isFinite(mu) || !Number.isFinite(sd) || xs.length < 2) return { lo: Number.NaN, hi: Number.NaN };
	// Normal approximation; good enough for the report plots.
	const half = 1.96 * (sd / Math.sqrt(xs.length));
	return { lo: mu - half, hi: mu + half };
}

function iqr(values: number[]): { p25: number; p75: number } {
	const xs = sortedFinite(values);
	return { p25: quantileSorted(xs, 0.25), p75: quantileSorted(xs, 0.75) };
}

export interface ExperimentBSummaryRow {
	nodeCount: number;
	noiseSigma: number;
	n: number;

	rmseAligned_median: number;
	rmseAligned_p25: number;
	rmseAligned_p75: number;
	rmseAligned_mean: number;
	rmseAligned_ci95_lo: number;
	rmseAligned_ci95_hi: number;

	maeAligned_median: number;
	maeAligned_p25: number;
	maeAligned_p75: number;
	maeAligned_mean: number;
	maeAligned_ci95_lo: number;
	maeAligned_ci95_hi: number;

	pairwiseDistMae_median: number;
	pairwiseDistMae_p25: number;
	pairwiseDistMae_p75: number;
	pairwiseDistMae_mean: number;
	pairwiseDistMae_ci95_lo: number;
	pairwiseDistMae_ci95_hi: number;
}

/**
 * Experiment B
 *
 * Goal
 * - Sweep UWB distance noise (sigma) and measure the final localization accuracy.
 *
 * Notes
 * - This is a "final score" experiment (no time series), run after a fixed duration.
 * - Node layout is deterministic for comparability.
 */
export function runExperimentB(): ExperimentBRow[] {
	// Default Experiment B output is aggregated (median over multiple seeds) so that
	// the resulting curve isn't dominated by one lucky/unlucky random realization.
	const raw = runExperimentBRaw();
	const byParams = new Map<string, ExperimentBRowRaw[]>();
	for (const r of raw) {
		const key = `${r.nodeCount}_${r.noiseSigma}`;
		const arr = byParams.get(key);
		if (arr) arr.push(r);
		else byParams.set(key, [r]);
	}

	return [...byParams.values()]
		.sort((a, b) => {
			const nc = a[0].nodeCount - b[0].nodeCount;
			if (nc !== 0) return nc;
			return a[0].noiseSigma - b[0].noiseSigma;
		})
		.map((rows) => ({
			nodeCount: rows[0].nodeCount,
			noiseSigma: rows[0].noiseSigma,
			rmse: median(rows.map((r) => r.rmse)),
			mae: median(rows.map((r) => r.mae)),
			rmseAligned: median(rows.map((r) => r.rmseAligned)),
			maeAligned: median(rows.map((r) => r.maeAligned)),
			pairwiseDistMae: median(rows.map((r) => r.pairwiseDistMae)),
		}));
}

/**
 * Experiment B (summary statistics)
 *
 * Intended for plots and reporting: per noise sigma, provide median + IQR and mean + 95% CI.
 * This is computed from the same raw rows produced by `runExperimentBRaw()`.
 */
export function runExperimentBSummary(): ExperimentBSummaryRow[] {
	const raw = runExperimentBRaw();
	const byParams = new Map<string, ExperimentBRowRaw[]>();
	for (const r of raw) {
		const key = `${r.nodeCount}_${r.noiseSigma}`;
		const arr = byParams.get(key);
		if (arr) arr.push(r);
		else byParams.set(key, [r]);
	}

	return [...byParams.values()]
		.sort((a, b) => {
			const nc = a[0].nodeCount - b[0].nodeCount;
			if (nc !== 0) return nc;
			return a[0].noiseSigma - b[0].noiseSigma;
		})
		.map((rows) => {
			const sigma = rows[0].noiseSigma;
			const rmseAlignedVals = rows.map((r) => r.rmseAligned);
			const maeAlignedVals = rows.map((r) => r.maeAligned);
			const pairwiseVals = rows.map((r) => r.pairwiseDistMae);

			const rmseAlignedIqr = iqr(rmseAlignedVals);
			const maeAlignedIqr = iqr(maeAlignedVals);
			const pairwiseIqr = iqr(pairwiseVals);

			const rmseAlignedCi = ci95(rmseAlignedVals);
			const maeAlignedCi = ci95(maeAlignedVals);
			const pairwiseCi = ci95(pairwiseVals);

			return {
				nodeCount: rows[0]?.nodeCount ?? 0,
				noiseSigma: sigma,
				n: rows.length,

				rmseAligned_median: median(rmseAlignedVals),
				rmseAligned_p25: rmseAlignedIqr.p25,
				rmseAligned_p75: rmseAlignedIqr.p75,
				rmseAligned_mean: mean(rmseAlignedVals),
				rmseAligned_ci95_lo: rmseAlignedCi.lo,
				rmseAligned_ci95_hi: rmseAlignedCi.hi,

				maeAligned_median: median(maeAlignedVals),
				maeAligned_p25: maeAlignedIqr.p25,
				maeAligned_p75: maeAlignedIqr.p75,
				maeAligned_mean: mean(maeAlignedVals),
				maeAligned_ci95_lo: maeAlignedCi.lo,
				maeAligned_ci95_hi: maeAlignedCi.hi,

				pairwiseDistMae_median: median(pairwiseVals),
				pairwiseDistMae_p25: pairwiseIqr.p25,
				pairwiseDistMae_p75: pairwiseIqr.p75,
				pairwiseDistMae_mean: mean(pairwiseVals),
				pairwiseDistMae_ci95_lo: pairwiseCi.lo,
				pairwiseDistMae_ci95_hi: pairwiseCi.hi,
			};
		});
}

/**
 * Experiment B (raw per-seed rows)
 *
 * Rationale:
 * - Single-seed curves can look non-monotonic because packet loss + noise are stochastic.
 * - For a fair sigma sweep, keep the RNG seed independent of sigma so the packet-loss pattern
 *   and random draw ordering are comparable across all noise levels.
 */
export function runExperimentBRaw(): ExperimentBRowRaw[] {
	const rows: ExperimentBRowRaw[] = [];
	const simSeconds = 300;
	const baseSeed = getCliSeed(1);
	const nodeCounts = [3, 8, 15];

	// Keep this list stable: it defines the X-axis for the sensitivity curve.
	const noiseSigmas = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

	// Increase for tighter confidence intervals; keep modest to avoid slow runs.
	const seedCount = 5;

	for (const nodeCount of nodeCounts) {
		const layout = makeSeed(nodeCount, seededRng(baseSeed + 200 + nodeCount));

		for (let k = 0; k < seedCount; k++) {
			// Seed depends only on replicate index (NOT sigma) so randomness is comparable across the sweep.
			const seed = baseSeed + 210 + k * 10_000 + nodeCount;
			for (const sigma of noiseSigmas) {
				try {
					const { estNodes } = solvePoseGraphFromRanging({
						seed,
						nodeLayout: layout,
						simSeconds,
						uwbNoiseSigma: sigma,
					});
					rows.push({
						seed,
						nodeCount,
						noiseSigma: sigma,
						rmse: rmse(estNodes as any),
						mae: mae(estNodes as any),
						rmseAligned: rmseAlignedRigid(estNodes as any),
						maeAligned: aleAlignedRigid(estNodes as any),
						pairwiseDistMae: pairwiseDistanceMae(estNodes as any),
					});
				} catch (e: unknown) {
					console.error(`ExpB Failed N=${nodeCount} Sig=${sigma}`, e);
				}
			}
		}
	}

	return rows;
}
