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
