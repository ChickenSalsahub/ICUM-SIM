type Vec2 = { x: number; y: number };
type Matrix = number[][];

function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

function add(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function sub(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function mul(A: Matrix, B: Matrix): Matrix {
  const result = Array(A.length).fill(0).map(() => Array(B[0].length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B[0].length; j++) {
      for (let k = 0; k < B.length; k++) {
        result[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return result;
}

function transpose(A: Matrix): Matrix {
  return A[0].map((_, i) => A.map(row => row[i]));
}

function inverse2x2(M: number[][]): number[][] {
  const [[a, b], [c, d]] = M;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-8) {
    throw new Error("Singular matrix");
  }
  return [
    [d / det, -b / det],
    [-c / det, a / det]
  ];
}

function mulVec(A: Matrix, v: number[]): number[] {
  return A.map(row => {
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
      const vi = v[i];
      if (!Number.isFinite(vi)) return NaN;
      sum += row[i] * vi;
    }
    return sum;
  });
}

function scaleMatrix(A: number[][], scalar: number): number[][] {
  return A.map(row => row.map(v => v * scalar));
}

function cloneMatrixQ(m: number[][]): number[][] {
  return [
    [m[0][0], m[0][1], m[0][2], m[0][3]],
    [m[1][0], m[1][1], m[1][2], m[1][3]],
    [m[2][0], m[2][1], m[2][2], m[2][3]],
    [m[3][0], m[3][1], m[3][2], m[3][3]]
  ];
}

function cloneMatrixR(m: number[][]): number[][] {
  return [
    [m[0][0], m[0][1]],
    [m[1][0], m[1][1]]
  ];
}

function computeNIS(y: number[], S: number[][]): number {
  const s00 = S[0][0], s01 = S[0][1];
  const s10 = S[1][0], s11 = S[1][1];
  const det = s00 * s11 - s01 * s10;
  if (Math.abs(det) < 1e-9) return 0;
  const invS00 = s11 / det;
  const invS01 = -s01 / det;
  const invS10 = -s10 / det;
  const invS11 = s00 / det;
  return (
    y[0] * (invS00 * y[0] + invS01 * y[1]) +
    y[1] * (invS10 * y[0] + invS11 * y[1])
  );
}

export class GlobalTransformEKF {
  x: number[];
  P: number[][];
  Q: number[][];
  R: number[][];
  Q0: number[][];
  R0: number[][];
  nis_ema: number;
  qScale: number;
  innovCovEMA: number[][];

  constructor(N: number = 1, R_val: number = 25) {
    this.x = [0, 0, 0, 0];
    this.P = scaleMatrix(identity(4), 100);
    this.Q = scaleMatrix(identity(4), N);
    this.R = [
      [R_val, 0],
      [0, R_val]
    ];
    this.Q0 = cloneMatrixQ(this.Q);
    this.R0 = cloneMatrixR(this.R);
    this.nis_ema = 2.0;
    this.qScale = 1.0;
    this.innovCovEMA = [
      [0, 0],
      [0, 0]
    ];
  }

  updateQ(Noise: number) {
    this.Q = scaleMatrix(identity(4), Noise);
  }

  updateR(Ar: number) {
    this.R = [
      [Ar, 0],
      [0, Ar],
    ];
  }

  predict(dt: number) {
    const F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    this.x = mulVec(F, this.x);
    this.P = add(
      mul(mul(F, this.P), transpose(F)),
      this.Q
    );
  }

  update(z: { x: number; y: number }) {
    const H = [
      [1, 0, 0, 0],
      [0, 1, 0, 0]
    ];
    const hx = [this.x[0], this.x[1]];
    const y = [z.x - hx[0], z.y - hx[1]];
    const S = add(mul(mul(H, this.P), transpose(H)), this.R);
    const yyT = [
      [y[0] * y[0], y[0] * y[1]],
      [y[1] * y[0], y[1] * y[1]]
    ];
    const rBeta = 0.95;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        this.innovCovEMA[i][j] = rBeta * this.innovCovEMA[i][j] + (1 - rBeta) * yyT[i][j];
      }
    }
    const HPHt = mul(mul(H, this.P), transpose(H));
    let Rest = sub(this.innovCovEMA, HPHt);
    Rest[0][0] = Math.max(Rest[0][0], 1e-4);
    Rest[1][1] = Math.max(Rest[1][1], 1e-4);
    Rest[0][1] = 0;
    Rest[1][0] = 0;
    const rAlpha = 0.98;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        this.R[i][j] = rAlpha * this.R[i][j] + (1 - rAlpha) * Rest[i][j];
      }
    }
    const nis = computeNIS(y, S);
    this.nis_ema = 0.9 * this.nis_ema + 0.1 * nis;
    const lower = 1.0;
    const upper = 2.0;
    let scale = 1.0;
    if (this.nis_ema > upper) {
      scale = 1 + 0.3 * (this.nis_ema / upper - 1);
    } else if (this.nis_ema < lower) {
      scale = 1 - 0.1 * (1 - this.nis_ema / lower);
    }
    scale = Math.max(0.5, Math.min(5.0, scale));
    this.qScale = 0.995 * this.qScale + 0.005 * scale;
    this.qScale = Math.max(0.25, Math.min(10.0, this.qScale));

    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (Math.abs(det) < 1e-6) {
      console.warn("Singular matrix S", S);
      return;
    }
    const K = mul(mul(this.P, transpose(H)), inverse2x2(S));
    const dx = mulVec(K, y);
    for (let i = 0; i < 4; i++) {
      this.x[i] += dx[i];
    }
    const I = identity(4);
    this.P = mul(sub(I, mul(K, H)), this.P);
  }

  getBias(): Vec2 {
    return {
      x: this.x[0],
      y: this.x[1]
    };
  }
}

export type LatLng = { lat: number; lng: number };

export function gpsToLocal(point: LatLng, origin: LatLng): Vec2 {
  const dLat = point.lat - origin.lat;
  const dLng = point.lng - origin.lng;
  const latRad = (origin.lat * Math.PI) / 180;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos(latRad);
  return {
    x: dLat * metersPerDegLat,
    y: dLng * metersPerDegLng,
  };
}

export function enuToLatLng(enu: Vec2, origin: LatLng): LatLng {
  const latRad = origin.lat * Math.PI / 180;
  const lat = origin.lat + (enu.x / 111_320);
  const lng = origin.lng + (enu.y / (111_320 * Math.cos(latRad)));
  return { lat, lng };
}
