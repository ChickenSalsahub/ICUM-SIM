import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { makeSeed, seedNodes } from "../lib/seed.ts";
import { applyMotionScenario } from "../lib/motion.ts";

export interface ExperimentKalmanAdaptiveRow {
	timeSeconds: number;
	rmseGps: number;
	rmseKalman: number;     // direct bias, fixed R=std², Q=0.01 (optimal fixed tuning)
	rmseAdaptive: number;   // adaptive R and Q (matches GlobalTransformEKF logic)
}

function gaussianNoise(std: number): number {
	let u = 0, v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Plain fixed-parameter Kalman filter (no adaptation). */
class FixedKF {
	x = [0, 0, 0, 0];
	P = [[100,0,0,0],[0,100,0,0],[0,0,100,0],[0,0,0,100]];
	R_: number; Q_: number;
	constructor(R: number, Q: number) { this.R_ = R; this.Q_ = Q; }

	predict(dt: number) {
		this.x = [this.x[0]+dt*this.x[2], this.x[1]+dt*this.x[3], this.x[2], this.x[3]];
		const p = this.P, q = this.Q_;
		this.P = [
			[p[0][0]+dt*p[2][0]+dt*p[0][2]+dt*dt*p[2][2]+q, p[0][1]+dt*p[2][1]+dt*p[0][3]+dt*dt*p[2][3],   p[0][2]+dt*p[2][2]+q, p[0][3]+dt*p[2][3]],
			[p[1][0]+dt*p[3][0]+dt*p[1][2]+dt*dt*p[3][2],   p[1][1]+dt*p[3][1]+dt*p[1][3]+dt*dt*p[3][3]+q, p[1][2]+dt*p[3][2],   p[1][3]+dt*p[3][3]+q],
			[p[2][0]+dt*p[2][2]+q, p[2][1]+dt*p[2][3], p[2][2]+q, p[2][3]],
			[p[3][0]+dt*p[3][2],   p[3][1]+dt*p[3][3], p[3][2],   p[3][3]+q],
		];
	}

	update(zx: number, zy: number) {
		const yx=zx-this.x[0], yy=zy-this.x[1];
		const s00=this.P[0][0]+this.R_, s11=this.P[1][1]+this.R_, s01=this.P[0][1], s10=this.P[1][0];
		const det=s00*s11-s01*s10;
		if (Math.abs(det)<1e-9) return;
		const K: number[][]=[];
		for (let i=0;i<4;i++) K.push([(this.P[i][0]*s11-this.P[i][1]*s10)/det,(this.P[i][1]*s00-this.P[i][0]*s01)/det]);
		for (let i=0;i<4;i++) this.x[i]+=K[i][0]*yx+K[i][1]*yy;
		const nP: number[][]=Array.from({length:4},()=>[0,0,0,0]);
		for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++)
			nP[i][j]+=((i===k?1:0)-(k<2?K[i][k]:0))*this.P[k][j];
		this.P=nP;
	}
}

/**
 * Adaptive Kalman filter — mirrors GlobalTransformEKF from kalman.tsx.
 *
 * Adaptive R: uses an EMA of the innovation outer product to estimate
 *             the true measurement noise covariance each step.
 * Adaptive Q: uses the Normalized Innovation Squared (NIS) to scale Q
 *             up when the filter is under-confident and down when over-confident.
 */
class AdaptiveKF {
	x = [0, 0, 0, 0];
	P = [[100,0,0,0],[0,100,0,0],[0,0,100,0],[0,0,0,100]];
	R: number[][];         // 2×2 measurement noise matrix (adapted each step)
	Q: number;             // scalar process noise (scaled by NIS each step)
	nisEma = 2.0;          // NIS exponential moving average (init at 2 = ideal for 2-DOF)
	innovCovEma = [[0,0],[0,0]];  // EMA of innovation outer product for adaptive R

	constructor(R0: number, Q0: number) {
		this.R = [[R0, 0], [0, R0]];
		this.Q = Q0;
	}

	predict(dt: number) {
		this.x = [this.x[0]+dt*this.x[2], this.x[1]+dt*this.x[3], this.x[2], this.x[3]];
		const p = this.P, q = this.Q;
		this.P = [
			[p[0][0]+dt*p[2][0]+dt*p[0][2]+dt*dt*p[2][2]+q, p[0][1]+dt*p[2][1]+dt*p[0][3]+dt*dt*p[2][3],   p[0][2]+dt*p[2][2]+q, p[0][3]+dt*p[2][3]],
			[p[1][0]+dt*p[3][0]+dt*p[1][2]+dt*dt*p[3][2],   p[1][1]+dt*p[3][1]+dt*p[1][3]+dt*dt*p[3][3]+q, p[1][2]+dt*p[3][2],   p[1][3]+dt*p[3][3]+q],
			[p[2][0]+dt*p[2][2]+q, p[2][1]+dt*p[2][3], p[2][2]+q, p[2][3]],
			[p[3][0]+dt*p[3][2],   p[3][1]+dt*p[3][3], p[3][2],   p[3][3]+q],
		];
	}

	update(zx: number, zy: number) {
		const yx=zx-this.x[0], yy=zy-this.x[1];

		// Innovation covariance S = H*P*Hᵀ + R (top-left 2×2 of P, plus R)
		const s00=this.P[0][0]+this.R[0][0], s11=this.P[1][1]+this.R[1][1],
		      s01=this.P[0][1]+this.R[0][1], s10=this.P[1][0]+this.R[1][0];
		const det=s00*s11-s01*s10;
		if (Math.abs(det)<1e-9) return;

		// ── Adaptive R ────────────────────────────────────────────────────────
		// Update EMA of innovation outer product: C_yy ≈ S
		const rBeta = 0.95;
		this.innovCovEma[0][0] = rBeta*this.innovCovEma[0][0] + (1-rBeta)*yx*yx;
		this.innovCovEma[0][1] = rBeta*this.innovCovEma[0][1] + (1-rBeta)*yx*yy;
		this.innovCovEma[1][0] = rBeta*this.innovCovEma[1][0] + (1-rBeta)*yy*yx;
		this.innovCovEma[1][1] = rBeta*this.innovCovEma[1][1] + (1-rBeta)*yy*yy;

		// R_est = C_yy - H*P*Hᵀ  (clamp to avoid negative variance)
		const hpht00=this.P[0][0], hpht11=this.P[1][1], hpht01=this.P[0][1], hpht10=this.P[1][0];
		const rAlpha = 0.98;
		this.R[0][0] = Math.max(1e-4, rAlpha*this.R[0][0] + (1-rAlpha)*Math.max(1e-4, this.innovCovEma[0][0]-hpht00));
		this.R[1][1] = Math.max(1e-4, rAlpha*this.R[1][1] + (1-rAlpha)*Math.max(1e-4, this.innovCovEma[1][1]-hpht11));
		this.R[0][1] = 0; this.R[1][0] = 0; // keep diagonal

		// ── Adaptive Q via NIS ────────────────────────────────────────────────
		// NIS = yᵀ S⁻¹ y
		const sinv00=(s11/det), sinv11=(s00/det), sinv01=(-s01/det), sinv10=(-s10/det);
		const nis = yx*(sinv00*yx+sinv01*yy) + yy*(sinv10*yx+sinv11*yy);
		this.nisEma = 0.9*this.nisEma + 0.1*nis;

		// For 2-DOF system, ideal NIS ≈ 2. Scale Q up if over-confident (NIS > 2.5), down if under.
		let scale = 1.0;
		if (this.nisEma > 2.5)      scale = 1 + 0.3*(this.nisEma/2.5 - 1);
		else if (this.nisEma < 1.5) scale = 1 - 0.1*(1 - this.nisEma/1.5);
		scale = Math.max(0.5, Math.min(5.0, scale));
		this.Q = Math.max(0.001, Math.min(10.0, this.Q * 0.995 + 0.005 * this.Q * scale));

		// ── Standard Kalman update ────────────────────────────────────────────
		const K: number[][]=[];
		for (let i=0;i<4;i++) K.push([(this.P[i][0]*s11-this.P[i][1]*s10)/det,(this.P[i][1]*s00-this.P[i][0]*s01)/det]);
		for (let i=0;i<4;i++) this.x[i]+=K[i][0]*yx+K[i][1]*yy;
		const nP: number[][]=Array.from({length:4},()=>[0,0,0,0]);
		for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++)
			nP[i][j]+=((i===k?1:0)-(k<2?K[i][k]:0))*this.P[k][j];
		this.P=nP;
	}
}

/**
 * Experiment: Kalman Adaptive vs Fixed Tuning
 *
 * Compares three approaches on the same GPS-denied scenario:
 *   1. Raw GPS RMSE          — static flat line = |initial bias|
 *   2. Fixed-tuned Kalman    — R = std², Q = 0.01 (optimal fixed params)
 *   3. Adaptive R/Q Kalman   — adapts R from innovation EMA, Q from NIS scaling
 *
 * Both filters start with the same initial R and Q (provided params).
 * The adaptive filter adjusts them each step; the fixed filter keeps them constant.
 */
export function runExperimentKalmanAdaptive(R: number, Q: number, std: number, n: number): ExperimentKalmanAdaptiveRow[] {
	const layout = makeSeed(n, Math.random);
	const rows: ExperimentKalmanAdaptiveRow[] = [];
	const runner = new SimulationRunner({
		worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
		seed: Date.now(),
		firmwareConfig: { eventDrivenSensing: false },
	});
	seedNodes(runner, layout);

	const trueBiasX = gaussianNoise(std);
	const trueBiasY = gaussianNoise(std);
	const staticGpsRmse = Math.sqrt(trueBiasX**2 + trueBiasY**2);

	// Fixed-tuned: R = std² (optimal), Q = 0.01 (nearly static bias)
	const kfFixed = new FixedKF(std * std, 0.01);

	// Adaptive: starts with provided R and Q, then adapts each step
	const kfAdapt = new AdaptiveKF(R, Q);

	const simSeconds = 600;
	const stepMs = 1000;

	for (let t = 0; t <= simSeconds * 1000; t += stepMs) {
		applyMotionScenario(runner, "many_moving", t);

		if (t > 0) {
			kfFixed.predict(stepMs / 1000);
			kfAdapt.predict(stepMs / 1000);

			// Noisy observation: trueBias + N(0, std) — same for both filters
			const ox = trueBiasX + gaussianNoise(std);
			const oy = trueBiasY + gaussianNoise(std);
			kfFixed.update(ox, oy);
			kfAdapt.update(ox, oy);
		}

		rows.push({
			timeSeconds: t / 1000,
			rmseGps: staticGpsRmse,
			rmseKalman:  Math.sqrt((trueBiasX-kfFixed.x[0])**2 + (trueBiasY-kfFixed.x[1])**2),
			rmseAdaptive: Math.sqrt((trueBiasX-kfAdapt.x[0])**2 + (trueBiasY-kfAdapt.x[1])**2),
		});
		runner.step(stepMs);
	}
	return rows;
}
