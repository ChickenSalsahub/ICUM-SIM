import type { SimulationRunner } from "../../engine/SimulationRunner.ts";
import type { RngFn } from "../../logic/math/Random.ts";
import { createMulberry32 } from "../../logic/math/Random.ts";
import { EXPERIMENT_AREA_SIZE_M, type SeededNode } from "./types.ts";

/**
 * Reads a deterministic seed from:
 * - CLI: `--seed=123` or `--seed 123`
 * - env: `EXPERIMENT_SEED=123`
 * - fallback: defaultSeed
 */
export function getCliSeed(defaultSeed: number): number {
	const argv = process.argv.slice(2);
	const eq = argv.find((a) => a.startsWith("--seed="));
	if (eq) {
		const v = Number(eq.split("=")[1]);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	const idx = argv.indexOf("--seed");
	if (idx >= 0 && idx + 1 < argv.length) {
		const v = Number(argv[idx + 1]);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	const env = process.env.EXPERIMENT_SEED;
	if (env !== undefined) {
		const v = Number(env);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	return defaultSeed;
}

/**
 * Generates a deterministic node layout uniformly in the experiment area.
 */
export function makeSeed(count: number, rng: RngFn): SeededNode[] {
	return Array.from({ length: count }).map((_, idx) => ({
		id: idx + 1,
		x: rng() * EXPERIMENT_AREA_SIZE_M.width*0.8 + EXPERIMENT_AREA_SIZE_M.width*0.1,
		y: rng() * EXPERIMENT_AREA_SIZE_M.height*0.8 + EXPERIMENT_AREA_SIZE_M.height*0.1,
	}));
}

/**
 * Adds nodes to the runner with a stable initial state.
 *
 * Convention used across experiments:
 * - Node 1 is LTE-capable (acts like a gateway-ish anchor in some policies).
 */
export function seedNodes(runner: SimulationRunner, nodes: SeededNode[]) {
	for (const node of nodes) {
		runner.addNode(node.id, { x: node.x, y: node.y }, { vx: 0, vy: 0 }, 3.7, node.id === 1);
	}
}

/**
 * Handy deterministic RNG factory.
 */
export function seededRng(seed: number): RngFn {
	return createMulberry32(seed);
}
