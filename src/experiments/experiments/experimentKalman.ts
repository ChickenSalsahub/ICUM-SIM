import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { makeSeed, seedNodes } from "../lib/seed.ts";
import { applyMotionScenario } from "../lib/motion.ts";

export interface ExperimentKalmanRow {
	timeSeconds: number;
	rmseGps: number;
	rmseEkf: number;        // simple: fixed R and Q (may be mis-calibrated)
	rmseEkfTuned: number;   // adaptive: R and Q adapt recursively via innovation metrics
}

type Matrix = number[][];
function transpose(A: Matrix): Matrix {
  return A[0].map((_, i) => A.map(row => row[i]));
}

function mul(A: Matrix, B: Matrix): Matrix {
  const result = Array(A.length)
    .fill(0)
    .map(() => Array(B[0].length).fill(0));

  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B[0].length; j++) {
      for (let k = 0; k < B.length; k++) {
        result[i][j] += A[i][k] * B[k][j];
        
      }
    }
  }
  
  return result;
}

function sub(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) =>
    row.map((v, j) => v - B[i][j])
  );
}


function gaussianNoise(std: number): number {
	let u = 0, v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/* class SimpleKF {
	x = [0, 0];
	P = [[100,0,0,0],[0,100]];
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
} */
class SimpleKF {
	x = [0, 0];
	P = [
		[100, 0],
		[0, 100]
	];

	R_: number;
	Q_: number;

	constructor(R: number, Q: number) {
		this.R_ = R;
		this.Q_ = Q;
	}

	predict(_: number) {
		const p = this.P;
		const q = this.Q_;

		this.P = [
			[p[0][0] + q, p[0][1]],
			[p[1][0], p[1][1] + q],
		];
	}

	update(zx: number, zy: number) {
		const yx = zx - this.x[0];
		const yy = zy - this.x[1];

		const s00 = this.P[0][0] + this.R_;
		const s11 = this.P[1][1] + this.R_;
		const s01 = this.P[0][1];
		const s10 = this.P[1][0];

		const det = s00 * s11 - s01 * s10;
		if (Math.abs(det) < 1e-9) return;

		const K = [
			[
				(this.P[0][0] * s11 - this.P[0][1] * s10) / det,
				(this.P[0][1] * s00 - this.P[0][0] * s01) / det
			],
			[
				(this.P[1][0] * s11 - this.P[1][1] * s10) / det,
				(this.P[1][1] * s00 - this.P[1][0] * s01) / det
			]
		];

		this.x[0] += K[0][0] * yx + K[0][1] * yy;
		this.x[1] += K[1][0] * yx + K[1][1] * yy;

		const nP = [
			[0, 0],
			[0, 0]
		];

		for (let i = 0; i < 2; i++) {
			for (let j = 0; j < 2; j++) {
				for (let k = 0; k < 2; k++) {
					nP[i][j] += (
						((i === k ? 1 : 0) - K[i][k])
						* this.P[k][j]
					);
				}
			}
		}

		this.P = nP;
	}
}
/* class AdaptiveKF {
	x = [0, 0, 0, 0];
	P = [[100,0,0,0],[0,100,0,0],[0,0,100,0],[0,0,0,100]];
	R: number[][];         // 2×2 measurement noise matrix (adapted each step)
	Q: number;             // scalar process noise (scaled by NIS each step)
	nisEma = 2.0;          // NIS exponential moving average (init at 2 = ideal for 2-DOF)
	innovCovEma = [[0,0],[0,0]];  // EMA of innovation outer product for adaptive R
	_updateCount = 0;      // DEBUG: count updates to log periodically

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

		const yyT = [
			[yx * yx, yx * yy],
			[yy * yx, yy * yy]
		];

		const H = [
			[1, 0, 0, 0],
			[0, 1, 0, 0]
		];

		const rBeta = 0.98;

		for (let i = 0; i < 2; i++) {
			for (let j = 0; j < 2; j++) {
				this.innovCovEma[i][j] =
					rBeta * this.innovCovEma[i][j] +
					(1 - rBeta) * yyT[i][j];
			}
		}

		const HPHt = mul(
			mul(H, this.P),
			transpose(H)
		);
		const adaptRate = 0.05;
		const R_MIN = 1e-2;
		const R_MAX = 1e3;
		const EPS = 1e-6;

		for (let i = 0; i < 2; i++) {
			const predicted =
				HPHt[i][i] + this.R[i][i];
			const observed =
				this.innovCovEma[i][i];

			const ratio =
				observed / (predicted + EPS);

			const alpha =
				ratio > 1.0
					? adaptRate
					: adaptRate * 0.1;
			this.R[i][i] *=
				(1 + alpha * (ratio - 1));
			this.R[i][i] = Math.max(
				R_MIN,
				Math.min(R_MAX, this.R[i][i])
			);
		}

		this.R[0][1] = 0;
		this.R[1][0] = 0;
		// ── Adaptive Q via NIS ────────────────────────────────────────────────
		// NIS = yᵀ S⁻¹ y
		const sinv00=(s11/det), sinv11=(s00/det), sinv01=(-s01/det), sinv10=(-s10/det);
		const nis = yx*(sinv00*yx+sinv01*yy) + yy*(sinv10*yx+sinv11*yy);
		this.nisEma = nis
		// = 0.1*this.nisEma + 0.9*nis;
		
		// DEBUG: Log adapted R and Q every 100 updates


		// For 2-DOF system, ideal NIS ≈ 2. Scale Q up if over-confident (NIS > 2.5), down if under.
		let scale = 1.0;
		if (this.nisEma <= 1){
			      scale = 1 + 0.3*(this.nisEma/2.5 - 1);
			}
		else if (this.nisEma > 1) {
			scale = 1 - 0.1*(1 - this.nisEma/1.5);
		}
		//scale = Math.max(1, Math.min(5.0, scale));
		this.Q = this.Q * scale

		if (!this._updateCount) this._updateCount = 0;
		this._updateCount++;
		if (this._updateCount % 100 === 0) {
			console.log(`[Adaptive KF] Update ${this._updateCount}: R[0][0]=${this.R[0][0].toFixed(3)}, Q=${this.Q.toFixed(6)}, NIS_EMA=${this.nisEma.toFixed(2)},  Scale=${scale}`);
		}
		//Math.max(0.001, Math.min(10.0, this.Q * 0.995 + 0.005 * this.Q * scale));

		// ── Standard Kalman update ────────────────────────────────────────────
		const K: number[][]=[];
		for (let i=0;i<4;i++) K.push([(this.P[i][0]*s11-this.P[i][1]*s10)/det,(this.P[i][1]*s00-this.P[i][0]*s01)/det]);
		for (let i=0;i<4;i++) this.x[i]+=K[i][0]*yx+K[i][1]*yy;
		const nP: number[][]=Array.from({length:4},()=>[0,0,0,0]);
		for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++)
			nP[i][j]+=((i===k?1:0)-(k<2?K[i][k]:0))*this.P[k][j];
		this.P=nP;
	}
} */
class AdaptiveKF {

	x = [0, 0];

	P = [
		[100, 0],
		[0, 100]
	];

	R: number[][];
	Q: number;

	nisEma = 2.0;

	innovCovEma = [
		[0, 0],
		[0, 0]
	];

	_updateCount = 0;

	constructor(R0: number, Q0: number) {
		this.R = [
			[R0, 0],
			[0, R0]
		];

		this.Q = Q0;
	}

	predict(dt: number) {

		const q = this.Q;

		// Constant bias random walk
		// x_k+1 = x_k + w

		this.P = [
			[
				this.P[0][0] + q * dt,
				this.P[0][1]
			],
			[
				this.P[1][0],
				this.P[1][1] + q * dt
			]
		];
	}

	update(zx: number, zy: number) {

		const yx = zx - this.x[0];
		const yy = zy - this.x[1];

		// Innovation covariance S = P + R

		const s00 = this.P[0][0] + this.R[0][0];
		const s11 = this.P[1][1] + this.R[1][1];
		const s01 = this.P[0][1] + this.R[0][1];
		const s10 = this.P[1][0] + this.R[1][0];

		const det = s00 * s11 - s01 * s10;

		if (Math.abs(det) < 1e-9) return;

		const yyT = [
			[yx * yx, yx * yy],
			[yy * yx, yy * yy]
		];

		const rBeta = 0.98;

		for (let i = 0; i < 2; i++) {
			for (let j = 0; j < 2; j++) {

				this.innovCovEma[i][j] =
					rBeta * this.innovCovEma[i][j] +
					(1 - rBeta) * yyT[i][j];
			}
		}

		const adaptRate = 0.05;

		const R_MIN = 1e-2;
		const R_MAX = 1e3;
		const EPS = 1e-6;

		for (let i = 0; i < 2; i++) {

			const predicted =
				this.P[i][i] + this.R[i][i];

			const observed =
				this.innovCovEma[i][i];

			const ratio =
				observed / (predicted + EPS);

			const alpha =
				ratio > 1.0
					? adaptRate
					: adaptRate * 0.1;

			this.R[i][i] *=
				(1 + alpha * (ratio - 1));

			this.R[i][i] = Math.max(
				R_MIN,
				Math.min(R_MAX, this.R[i][i])
			);
		}

		this.R[0][1] = 0;
		this.R[1][0] = 0;

		// NIS

		const sinv00 = s11 / det;
		const sinv11 = s00 / det;
		const sinv01 = -s01 / det;
		const sinv10 = -s10 / det;

		const nis =
			yx * (sinv00 * yx + sinv01 * yy) +
			yy * (sinv10 * yx + sinv11 * yy);

		this.nisEma = nis;

		let scale = 1.0;

		if (this.nisEma > 2) {

			scale =
				1 + 0.3 * (this.nisEma / 2);

		} else if (this.nisEma < 1) {

			scale =
				1 - 0.1 * (1 - this.nisEma / 1);
		}

		this.Q = this.Q * scale;

		this._updateCount++;

		/* if (this._updateCount % 100 === 0) {

			console.log(
				`[Adaptive KF] Update ${this._updateCount}: ` +
				`R[0][0]=${this.R[0][0].toFixed(3)}, ` +
				`Q=${this.Q.toFixed(6)}, ` +
				`NIS_EMA=${this.nisEma.toFixed(2)}, ` +
				`Scale=${scale}`
			);
		} */

		// Kalman gain K = P * inv(S)

		const K = [
			[
				(this.P[0][0] * s11 - this.P[0][1] * s10) / det,
				(this.P[0][1] * s00 - this.P[0][0] * s01) / det
			],
			[
				(this.P[1][0] * s11 - this.P[1][1] * s10) / det,
				(this.P[1][1] * s00 - this.P[1][0] * s01) / det
			]
		];

		// State update

		this.x[0] += K[0][0] * yx + K[0][1] * yy;
		this.x[1] += K[1][0] * yx + K[1][1] * yy;

		// P = (I - K)P

		const IminusK = [
			[
				1 - K[0][0],
				-K[0][1]
			],
			[
				-K[1][0],
				1 - K[1][1]
			]
		];

		const p = this.P;

		this.P = [
			[
				IminusK[0][0] * p[0][0] +
				IminusK[0][1] * p[1][0],

				IminusK[0][0] * p[0][1] +
				IminusK[0][1] * p[1][1]
			],
			[
				IminusK[1][0] * p[0][0] +
				IminusK[1][1] * p[1][0],

				IminusK[1][0] * p[0][1] +
				IminusK[1][1] * p[1][1]
			]
		];
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
 *   SIMPLE (green):    fixed R and Q (provided, may be mis-calibrated).
 *                      Never adapts → performance depends entirely on initial tuning.
 *   ADAPTIVE (orange): starts with provided R and Q, then adapts them recursively via:
 *                      - R: adjusted by innovation covariance ratio
 *                      - Q: adjusted by Normalized Innovation Squared (NIS)
 *                      Goal: converge to accurate noise estimates and stabilize.
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

function getFurthestPoints(
	points: Array<{ x: number; y: number }>
): [
	{ pointi: { x: number; y: number }; indexi: number },
	{ pointj: { x: number; y: number }; indexj: number }
] | null {

	if (points.length < 2) return null;

	let maxDistSq = -Infinity;

	let iMax = 0;
	let jMax = 1;

	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {

			const dx = points[i].x - points[j].x;
			const dy = points[i].y - points[j].y;

			const distSq = dx * dx + dy * dy;

			if (distSq > maxDistSq) {
				maxDistSq = distSq;
				iMax = i;
				jMax = j;
			}
		}
	}

	return [
		{
			pointi: points[iMax],
			indexi: iMax
		},
		{
			pointj: points[jMax],
			indexj: jMax
		}
	];
}

export function runExperimentKalman(R: number, Q: number, std: number, n: number): ExperimentKalmanRow[] {
	let layout = makeSeed(n, Math.random);
	const anchorNode = Math.floor(Math.random() * n);
	let anchorPositions: Array<{ x: number, y: number }> = [];
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
	
	// Simple: fixed R and Q (may be poorly calibrated).
	const kf = new SimpleKF(R, Q);
	// Adaptive: starts with same R and Q, then adapts them recursively during updates.
	const kfT = new AdaptiveKF(R, Q);

	const simSeconds = 600;
	const stepMs = 1000;

	for (let t = 0; t <= simSeconds * 1000; t += stepMs) {
		applyMotionScenario(runner, "many_moving", t);

		if (t > 0) {

			const motion = generateMotion(-10, 10, layout.length, anchorNode)

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
				//console.log(`Observation at t=${t/1000}s: sx=${(sx/count).toFixed(2)}, sy=${(sy/count).toFixed(2)}`);
		
			}

			anchorPositions.push({ x: layout[anchorNode].x-kf.x[0], y: layout[anchorNode].y-kf.x[1] });
			//console.log(anchorPositions[anchorPositions.length-1].x, kf.x[0], layout[anchorNode].x, truePos[anchorNode].x);
		}
		for (let i = 0; i < layout.length; i++) {
				if (layout[i]) {
						layout[i].x = kf.x[0];
						layout[i].y = kf.x[1];

						layoutT[i].x = kfT.x[0];
						layoutT[i].y = kfT.x[1];
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

			const ekfRmse  = Math.sqrt((
				trueBiasX-(
					kf.x[0]// > 0 ? kf.x[0]// + Math.sqrt(R) : kf.x[0] - Math.sqrt(R)
				))**2  + 
				(trueBiasY-(
					kf.x[1]// > 0 ? kf.x[1] + Math.sqrt(R) : kf.x[1] - Math.sqrt(R)
				))**2);
			const ekfRmseT = Math.sqrt((
				trueBiasX-(
					kfT.x[0]// > 0 ? kfT.x[0] : kfT.x[0]
				))**2 + (trueBiasY-(
					kfT.x[1]// > 0 ? kfT.x[1] : kfT.x[1]
				))**2);

			rows.push({ timeSeconds: t/1000, rmseGps: staticGpsRmse, rmseEkf: ekfRmse, rmseEkfTuned: ekfRmseT });
			runner.step(stepMs);
			//console.log(kf.R_, kf.Q_, kfT.R, kfT.Q);
		
	
	}
	console.log(getFurthestPoints(anchorPositions));
	return rows;
}

