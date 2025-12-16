export interface CloudPublishTrackerOptions {
	/** Publish at least this often even if stationary/stable. */
	staleMs?: number;
}

export interface ShouldPublishInput {
	nodeId: number;
	nowMs: number;
	isAnchor?: boolean;
	isMoving?: boolean;
	neighborIds?: number[];
}

/**
 * Shared "publish only when there's new information" policy.
 *
 * Used by both UI (`App.tsx`) and headless experiments (`experiments/runner.ts`)
 * so they cannot drift.
 */
export class CloudPublishTracker {
	private readonly staleMs: number;
	private readonly reportedOnce = new Set<number>();
	private readonly lastPublishMs = new Map<number, number>();
	private readonly neighborSig = new Map<number, string>();

	constructor(opts?: CloudPublishTrackerOptions) {
		this.staleMs = opts?.staleMs ?? 30_000;
	}

	public reset() {
		this.reportedOnce.clear();
		this.lastPublishMs.clear();
		this.neighborSig.clear();
	}

	public shouldPublish(input: ShouldPublishInput): boolean {
		const isAnchor = input.isAnchor ?? false;
		const isMoving = input.isMoving ?? false;
		const neighborIds = input.neighborIds ?? [];

		const sorted = [...neighborIds].sort((a, b) => a - b);
		const sig = sorted.join(",");
		const prevSig = this.neighborSig.get(input.nodeId) ?? "";
		const topologyChanged = sig !== prevSig;
		this.neighborSig.set(input.nodeId, sig);

		const first = !this.reportedOnce.has(input.nodeId);
		const last = this.lastPublishMs.get(input.nodeId) ?? 0;
		const stale = input.nowMs - last > this.staleMs;

		const publish = isAnchor || isMoving || first || topologyChanged || stale;
		if (publish) {
			this.reportedOnce.add(input.nodeId);
			this.lastPublishMs.set(input.nodeId, input.nowMs);
		}
		return publish;
	}
}
