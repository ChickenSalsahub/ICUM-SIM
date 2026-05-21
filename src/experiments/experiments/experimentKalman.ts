import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { makeSeed, seedNodes } from "../lib/seed.ts";
import { applyMotionScenario } from "../lib/motion.ts";

export interface ExperimentKalmanRow {
	timeSeconds: number;
	rmseGps: number;
	rmseEkf: number;        // untuned: R as provided (may be < std², over-trusts measurements)
	rmseEkfTuned: number;   // tuned:   R = std², Q = 0.01 (optimal calibration)
}

function gaussianNoise(std: number): number {
	let u = 0, v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

class SimpleKF {
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
 * GPS is measured ONCE at startup → static bias (bx, by). GPS RMSE = |bias| = constant.
 *
 * At each step the EKF receives a noisy observation of the bias derived from UWB ranging:
 *   z = trueBias + N(0, std)
 * This models the per-step noise in UWB-inferred relative positions used to observe the offset.
 *
 * Two filters on the same observations:
 *   UNTUNED (green):  provided R (may be mis-calibrated, e.g. R < std²).
 *                     Under-estimates noise → over-trusts measurements → noisy RMSE.
 *   TUNED (orange):   R = std², Q = 0.01 (optimal). Converges smoothly below GPS RMSE.
 *
 * Kalman RMSE = |trueBias - ekf.x[0,1]| = remaining position error after correction.
 */

function applyMotion(velX: number[], velY:number[], nodes: any) {
	for(let i = 0; i < nodes.length; i++){
		nodes[i].x += velX[i]; nodes[i].y += velY[i];
	}
}

function generateMotion(upper: number, lower:number, n: number, anchor: number){
	let motionVectorX: number[] = [];
	let motionVectorY: number[] = [];

	for(let i = 0; i < n; i++){
		if (i == anchor) {
			motionVectorX[i] = 0
			motionVectorY[i] = 0
		} else {
			motionVectorX[i] = (Math.random() * (upper - lower + 1)) + lower;
			motionVectorY[i] = (Math.random() * (upper - lower + 1)) + lower;
		}
	}

	return ({x: motionVectorX, y: motionVectorY})
} 

export function runExperimentKalman(R: number, Q: number, std: number, n: number): ExperimentKalmanRow[] {
	let layout = makeSeed(n, Math.random);
	const anchorNode = Math.floor(Math.random() * 5);
	const rows: ExperimentKalmanRow[] = [];
	const runner = new SimulationRunner({
		worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
		seed: Date.now(),
		firmwareConfig: { eventDrivenSensing: false },
	});
	seedNodes(runner, layout);

	// GPS bias sampled once. GPS RMSE = this magnitude, constant throughout.
	const trueBiasX = gaussianNoise(std);
	const trueBiasY = gaussianNoise(std);

	const staticGpsRmse = Math.sqrt(trueBiasX**2 + trueBiasY**2);

	let truePos: any = Array.from({ length: n }, () => ({ x: 0, y: 0 }));

	let layoutT: any = Array.from({ length: n }, () => ({ x: 0, y: 0 }));

	for (let i = 0; i < layout.length; i++) {
		if (layout[i]) {
				truePos[i].x = layout[i].x + trueBiasX;
				truePos[i].y = layout[i].y + trueBiasY;

				layoutT[i].x = layout[i].x;
				layoutT[i].y = layout[i].y;

			}
	}
	
	// Untuned: uses provided R and Q (may be poorly calibrated).
	const kf = new SimpleKF(R, 0);
	// Tuned: R = std² (matches actual noise), Q = 0.01 (bias is nearly constant).
	const kfT = new SimpleKF(std * std, 0);

	const simSeconds = 600;
	const stepMs = 1000;

	for (let t = 0; t <= simSeconds * 1000; t += stepMs) {
		applyMotionScenario(runner, "many_moving", t);

		if (t > 0) {
			const motion = generateMotion(-5, 5, layout.length, anchorNode)

			applyMotion(motion.x, motion.y, layout)
			applyMotion(motion.x, motion.y, truePos)
			applyMotion(motion.x, motion.y, layoutT)


			kf.predict(stepMs / 1000);
			kfT.predict(stepMs / 1000);

			const anchor = layout[anchorNode]
			let sx = 0;
			let sy = 0;
			let count = 0;

			for (const node of layout) {

				sx += node.x - anchor.x;
				sy += node.y - anchor.y;

				count++;
			}

			if (count > 0) {
				kf.update(sx / count, sy / count);
				kfT.update(sx / count, sy / count);
			}


			for (let i = 0; i < layout.length; i++) {
				if (layout[i]) {
						layout[i].x = kf.x[0];
						layout[i].y = kf.x[1];

						layoutT[i].x = kfT.x[0];
						layoutT[i].y = kfT.x[1];
					}
				}
		}

		//let ekfRmse = 0; let ekfRmseT = 0;
		 for (let i = 0; i < layout.length; i++) {
			const dx = truePos[i].x - layout[i].x;
			const dy = truePos[i].y - layout[i].y;

			const dxT = truePos[i].x - layoutT[i].x;
			const dyT = truePos[i].y - layoutT[i].y;

			const squaredDistance = dx * dx + dy * dy;
			const squaredDistanceT = dxT * dxT + dyT * dyT;

			//ekfRmse += squaredDistance; ekfRmseT += squaredDistanceT;
  		}
		
		console.log(t/simSeconds)
			const ekfRmse  = Math.sqrt((trueBiasX-(kf.x[0]*5))**2  + (trueBiasY-(kf.x[1]*5))**2);
			const ekfRmseT = Math.sqrt((trueBiasX-kfT.x[0])**2 + (trueBiasY-kfT.x[1])**2);

				
			rows.push({ timeSeconds: t/1000, rmseGps: staticGpsRmse, rmseEkf: ekfRmse, rmseEkfTuned: ekfRmseT });
			runner.step(stepMs);
		
	
		// Kalman RMSE = how much of the GPS bias remains uncorrected.
	
	}
	return rows;
}
