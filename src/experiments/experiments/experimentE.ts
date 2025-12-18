import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { rmse, sumTx } from "../lib/metrics.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentETimeRow {
	scenario: string;
	policy: "baseline" | "icum";
	seed: number;
	timeSeconds: number;
	txTotal: number;
	rmse: number;
}

/**
 * Experiment E
 *
 * Goal
 * - A compact A/B experiment runner that compares two policies across scenarios.
 *
 * Why it exists (vs Experiment A)
 * - Experiment A is a single time series comparison.
 * - Experiment E is meant for repeated paper-style runs with explicit seed per policy+scenario,
 *   and it uses a finer simulation timestep to more closely approximate continuous behavior.
 */
export function runExperimentE(): ExperimentETimeRow[] {
	const baseSeed = getCliSeed(1);
	const simSeconds = 300;
	const dtMs = 250;
	const logEveryMs = 1_000;
	const nodeCount = 10;
	const layout = makeSeed(nodeCount, seededRng(baseSeed + 600));

	const makeRunner = (policy: "baseline" | "icum", seed: number) =>
		new SimulationRunner({
			uwbNoiseSigma: 0.05,
			seed,
			firmwareConfig:
				policy === "baseline"
					? {
							eventDrivenSensing: false,
							helloIntervalMovingMs: 2_000,
							helloIntervalIdleMs: 2_000,
							rangingIntervalMovingMs: 2_000,
							rangingIntervalIdleMs: 2_000,
							neighborTimeoutMs: 5_000,
					  }
					: { eventDrivenSensing: true },
		});

	const scenarios: Array<{ name: string; apply: (runner: SimulationRunner, tMs: number) => void }> = [
		{ name: "none_moving", apply: () => {} },
		{
			name: "few_moving",
			apply: (runner, tMs) => {
				if (tMs === 120_000) {
					runner.setNodeVelocity(2, { vx: 0.5, vy: 0 });
					runner.setNodeVelocity(3, { vx: 0.0, vy: 0.5 });
					runner.setNodeVelocity(4, { vx: -0.35, vy: 0.35 });
				}
				if (tMs === 180_000) {
					runner.setNodeVelocity(2, { vx: 0, vy: 0 });
					runner.setNodeVelocity(3, { vx: 0, vy: 0 });
					runner.setNodeVelocity(4, { vx: 0, vy: 0 });
				}
			},
		},
		{
			name: "many_moving",
			apply: (runner, tMs) => {
				if (tMs === 120_000) {
					runner.setNodeVelocity(2, { vx: 0.5, vy: 0.0 });
					runner.setNodeVelocity(3, { vx: 0.0, vy: 0.5 });
					runner.setNodeVelocity(4, { vx: -0.35, vy: 0.35 });
					runner.setNodeVelocity(5, { vx: 0.25, vy: -0.4 });
					runner.setNodeVelocity(6, { vx: -0.45, vy: 0.1 });
					runner.setNodeVelocity(7, { vx: 0.15, vy: 0.45 });
					runner.setNodeVelocity(8, { vx: -0.2, vy: -0.35 });
				}
				if (tMs === 180_000) {
					for (const id of [2, 3, 4, 5, 6, 7, 8]) runner.setNodeVelocity(id, { vx: 0, vy: 0 });
				}
			},
		},
	];

	const rows: ExperimentETimeRow[] = [];

	for (const scenario of scenarios) {
		for (const policy of ["baseline", "icum"] as const) {
			const seed = baseSeed + 700 + scenario.name.length * 31 + (policy === "baseline" ? 1 : 2);
			const runner = makeRunner(policy, seed);
			runner.setWorldBounds(EXPERIMENT_WORLD_BOUNDS_M);
			seedNodes(runner, layout);

			let nextLog = 0;
			for (let tMs = 0; tMs <= simSeconds * 1000; tMs += dtMs) {
				scenario.apply(runner, tMs);
				if (tMs >= nextLog) {
					const snap = runner.snapshot();
					rows.push({
						scenario: scenario.name,
						policy,
						seed,
						timeSeconds: tMs / 1000,
						txTotal: sumTx(snap.nodes),
						rmse: rmse(snap.nodes),
					});
					nextLog += logEveryMs;
				}
				runner.step(dtMs);
			}
		}
	}

	return rows;
}
