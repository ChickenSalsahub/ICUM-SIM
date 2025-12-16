import { RangingEngine, RangingOptions, RangingResult, Wall } from "../types";

// Simple UWB ranging simulator.
// - Positions are in pixels; convert to meters using opts.pixelsPerMeter
// - Checks line-of-sight against walls (segments)
// - Applies Gaussian noise to distance (configurable via RNG)

export class UWBRanging implements RangingEngine {
	private rng: () => number;
	private noiseStdMeters: number;

	constructor(_pixelsPerMeter: number, opts?: { rng?: () => number; noiseStdMeters?: number }) {
		// Default RNG: Math.random
		this.rng = opts?.rng ?? Math.random;
		this.noiseStdMeters = opts?.noiseStdMeters ?? 0.05; // 5cm default noise
	}

	public measure(
		sender: { id: number; x: number; y: number },
		receiver: { id: number; x: number; y: number },
		opts: RangingOptions
	): RangingResult {
		const { pixelsPerMeter, maxRangeMeters, walls } = opts;
		// Vector from sender -> receiver (bearing as seen by sender)
		const dx = receiver.x - sender.x;
		const dy = receiver.y - sender.y;
		const trueDistMeters = Math.sqrt(dx * dx + dy * dy) / pixelsPerMeter;

		const los = this.isLineOfSight(sender, receiver, walls || []);

		if (trueDistMeters > maxRangeMeters) {
			return {
				success: false,
				trueDistanceMeters: trueDistMeters,
				measuredDistanceMeters: Infinity,
				los,
				error: "out_of_range",
			};
		}

		if (!los) {
			// No LOS: UWB often fails or produces wildly wrong results. We model as failure.
			return {
				success: false,
				trueDistanceMeters: trueDistMeters,
				measuredDistanceMeters: Infinity,
				los,
				error: "blocked",
			};
		}

		// Add Gaussian noise via Box-Muller
		const noise = this.gaussian() * this.noiseStdMeters;
		const measured = Math.max(0, trueDistMeters + noise);
		const c = 299_792_458; // speed of light m/s
		const tof = measured / c;

		// Bearing from sender to receiver; use as AoD (transmit) and as AoA at sender-side consumer
		const bearing = Math.atan2(dy, dx);
		const aoaNoise = this.gaussian() * 0.05; // ~3 degrees noise
		const aodNoise = this.gaussian() * 0.05;
		const aoa = bearing + aoaNoise; // what the initiator/firmware cares about (direction to peer)
		const aod = bearing + aodNoise; // transmitter departure angle (should closely match aoa)

		return {
			success: true,
			trueDistanceMeters: trueDistMeters,
			measuredDistanceMeters: measured,
			timeOfFlightSeconds: tof,
			aoa,
			aod,
			los,
		};
	}

	// Simple line-segment intersection based LOS check
	private isLineOfSight(a: { x: number; y: number }, b: { x: number; y: number }, walls: Wall[]) {
		for (const w of walls) {
			if (this.doIntersect({ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }))
				return false;
		}
		return true;
	}

	private doIntersect(p1: any, q1: any, p2: any, q2: any) {
		const orientation = (p: any, q: any, r: any) => {
			const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
			if (val === 0) return 0;
			return val > 0 ? 1 : 2;
		};
		const onSegment = (p: any, q: any, r: any) => {
			return (
				q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
			);
		};

		const o1 = orientation(p1, q1, p2);
		const o2 = orientation(p1, q1, q2);
		const o3 = orientation(p2, q2, p1);
		const o4 = orientation(p2, q2, q1);

		if (o1 !== o2 && o3 !== o4) return true;
		if (o1 === 0 && onSegment(p1, p2, q1)) return true;
		if (o2 === 0 && onSegment(p1, q2, q1)) return true;
		if (o3 === 0 && onSegment(p2, p1, q2)) return true;
		if (o4 === 0 && onSegment(p2, q1, q2)) return true;
		return false;
	}

	// Box-Muller transform
	private gaussian() {
		let u = 0,
			v = 0;
		while (u === 0) u = this.rng();
		while (v === 0) v = this.rng();
		return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
	}
}

export default UWBRanging;
