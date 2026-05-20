import React, {  useRef, useEffect, useState } from "react";
import { FusedRecord } from "./logic/CloudBackend";
import {
	NotebookPen,
} from "lucide-react";

export function getLatestPerNode(data: FusedRecord[]): Record<number, any> {
    const latest: Record<number, FusedRecord> = {};
    let origin =  undefined;
    let originNodeId = undefined;

    for (const item of data) {
        const existing = latest[item.nodeId];

        if (!existing || item.timestamp > existing.timestamp) {
          latest[item.nodeId] = item;
        }
    }

    const positions = Object.fromEntries(Object.entries(latest).map(([nodeId, item]) => [
            nodeId,
            item.position
        ])
    );

    for (const item of data){
        if(!item.position.lat){break}
        origin = item.position
        originNodeId = item.nodeId
    }

    return [{positions, origin, originNodeId}];
}

let R = 25; let N = 1; let globalDt: number; let sTD = 5; 

let offSetx = gaussianNoise(sTD); 
let offSety = gaussianNoise(sTD);

const handleSetR = (EKF: Record<number, GlobalTransformEKF>) => {
  const r = prompt("Enter how noisy we THINK the GPS is", "The higher, the noiser (Square the number)");
  if (r){
    R = parseFloat(r)
    for (const ekf of Object.values(EKF)) {
      ekf.updateR(R)
    }
  }
  
}
const handleSetNoise = (EKF: Record<number, GlobalTransformEKF>) => {
  const n = prompt("Enter how much we trust our motion model", "More trust the lower the number");
  if (n){
    N = parseFloat(n)
     for (const ekf of Object.values(EKF)) {
      ekf.updateQ(N)
    }
  }
}
const handleSetSTD = () => {
 const std = prompt("Enter how large the std for noise ACTUALLY is", "Change BEFORE initialization");
  if (std){
    sTD = parseFloat(std)
    offSetx = gaussianNoise(sTD)
    offSety = gaussianNoise(sTD)
  }
}

type Vec2 = { x: number; y: number };

export type NodeLocation = {
  nodeId: number;
  kalmanLat: number;
  kalmanLng: number;
  lat: number;
  lng: number;
};

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
  return A.map((row, i) =>
    row.map((v, j) => v - B[i][j])
  );
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

function transpose(A: Matrix): Matrix {
  return A[0].map((_, i) => A.map(row => row[i]));
}

// NOTE: naive 2x2 inverse (only used for S)
function inverse2x2(M: number[][]): number[][] {
  const [[a, b], [c, d]] = M;
  const det = a * d - b * c;

  if (Math.abs(det) < 1e-8) {
    throw new Error("Singular matrix");
  }

  return [
    [ d / det, -b / det],
    [-c / det,  a / det]
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

function addVec(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]);
}

function rotate(p: Vec2, theta: number): Vec2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    x: c * p.x - s * p.y,
    y: s * p.x + c * p.y,
  };
}

function normalizeAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
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

  const invS00 =  s11 / det;
  const invS01 = -s01 / det;
  const invS10 = -s10 / det;
  const invS11 =  s00 / det;

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
  constructor() {
    // [bias_x, bias_y, vel_x, vel_y]
    this.x = [0, 0, 0, 0];

    this.P = scaleMatrix(identity(4), 100);

    /* this.Q = [
      [0.01, 0, 0, 0],
      [0, 0.01, 0, 0],
      [0, 0, 0.1, 0],
      [0, 0, 0, 0.1]
    ]; */
    this.Q = scaleMatrix(identity(4), N);

    this.R = [
      [R, 0],
      [0, R]
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

    const hx = [
      this.x[0],
      this.x[1]
    ];

    const y = [
      z.x - hx[0],
      z.y - hx[1]
    ];

    const S = add(
      mul(mul(H, this.P), transpose(H)),
      this.R
    );

    //Adaptive Q and R
    const yyT = [
      [y[0] * y[0], y[0] * y[1]],
      [y[1] * y[0], y[1] * y[1]]
    ];

    const rBeta = 0.95;

    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        this.innovCovEMA[i][j] =
          rBeta * this.innovCovEMA[i][j] +
          (1 - rBeta) * yyT[i][j];
      }
    }
    
    const HPHt = mul(
      mul(H, this.P),
      transpose(H)
    );

    let Rest = sub(this.innovCovEMA, HPHt);

    Rest[0][0] = Math.max(Rest[0][0], 1e-4);
    Rest[1][1] = Math.max(Rest[1][1], 1e-4);
    Rest[0][1] = 0;
    Rest[1][0] = 0;

    const rAlpha = 0.98;

    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        this.R[i][j] =
          rAlpha * this.R[i][j] +
          (1 - rAlpha) * Rest[i][j];
      }
    } 

    const nis = computeNIS(y, S);

    this.nis_ema = 0.9 * this.nis_ema + 0.1 * nis;

    // thresholds for 2D
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

   /*  for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        this.Q[i][j] = this.Q0[i][j] * this.qScale
      }
    } */
    
    console.log(this.Q[0][0], this.R[0][0])
    N = this.Q[0][0]; R = this.R[0][0];

    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    
    if (Math.abs(det) < 1e-6) {
      console.warn("Singular matrix S", S);
      return;
    } 

    const K = mul(
      mul(this.P, transpose(H)),
      inverse2x2(S)
    );

    const dx = mulVec(K, y);

    for (let i = 0; i < 4; i++) {
      this.x[i] += dx[i];
    }

    const I = identity(4);

    this.P = mul(
      sub(I, mul(K, H)),
      this.P
    );
  }

  getBias(): Vec2 {
    return {
      x: this.x[0],
      y: this.x[1]
    };
  }
}

type LatLng = { lat: number; lng: number };


function gpsToLocal( point: LatLng, origin: LatLng ): Vec2 {
  let dLat = point.lat - origin.lat;
  let dLng = point.lng - origin.lng;

  //This might honestly break sum shit
  /* if (dLat == 0 && dLng == 0) {
    dLat = 0.000001, dLng = 0.000001;
  } */


  const latRad = (origin.lat * Math.PI) / 180;

  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos(latRad);

  return {
    x: dLat * metersPerDegLat,
    y: dLng * metersPerDegLng,
  };
}

/* function toGlobal(rel: Vec2, ekf: GlobalTransformEKF, origin: LatLng): Vec2 {
  const [px, py] = ekf.x;

  const x = rel.x + px;
  const y = rel.y + py;

  const latRad = origin.lat * Math.PI / 180;

  const lat = origin.lat + (x / 111320);
  const lng = origin.lng + (y / (111320 * Math.cos(latRad)));

  return { x: lat, y: lng };
} */

/* function toGlobal(rel: Vec2, ekf: GlobalTransformEKF): Vec2 {
  const [east, north] = ekf.x;

  return {
    x: rel.x + east,
    y: rel.y + north
  };
} */

function enuToLatLng(enu: Vec2, origin: LatLng): LatLng {
  const latRad = origin.lat * Math.PI / 180;

  const lat = origin.lat + (enu.x / 111320);
  const lng = origin.lng + (enu.y / (111320 * Math.cos(latRad)));

  return { lat, lng };
}



let renderLocations: NodeLocation[] = [];
let renderEKF: Record<number, GlobalTransformEKF>
let renderOrigin: LatLng;
let renderTrue: Record<number, {x: number, y: number}> = []
let posChange: Record<number,{ prev: Vec2; curr: Vec2 }> = [];

function gaussianNoise(std: number) {
  return std * Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}


const simState: Record<number, {
  truePos: Vec2;
  ekf: GlobalTransformEKF;
}> = {};

export function updateEKFCanvasState(
  locations: NodeLocation[],
  originLat: number,
  originLng: number
){
  renderLocations = locations; 
  //renderEKF = ekfMap;
  renderOrigin = { lat: originLat, lng: originLng }

  function generatePos(nodeId: number) {
    const ogGPS = gpsToLocal({ lat: renderLocations[nodeId]?.lat || 0, lng: renderLocations[nodeId]?.lng || 0 }, renderOrigin);
    return {
      x: ogGPS.x + offSetx,
      y: ogGPS.y + offSety
    };
  }

  for (const node of locations) {
    if (node.lat === undefined || node.lng === undefined) continue;

    const measuredENU = gpsToLocal({lat: node.lat, lng: node.lng}, {lat: originLat, lng: originLng});

    if (!posChange[node.nodeId]){
        posChange[node.nodeId] = {
          prev: {x:0,y:0}, 
          curr: measuredENU
        };
      } else {
        posChange[node.nodeId].prev = posChange[node.nodeId].curr
        posChange[node.nodeId].curr = measuredENU
      }

    const nowPos = generatePos(node.nodeId - 1);
    if (!simState[node.nodeId]) {
      simState[node.nodeId] = {
        truePos: { x: nowPos.x, y: nowPos.y },
        ekf: null as any
      };
    }

    const sim = simState[node.nodeId];
    const a1 = posChange[node.nodeId].curr.x - posChange[node.nodeId].prev.x;
    const a2 = posChange[node.nodeId].curr.y - posChange[node.nodeId].prev.y;

    sim.truePos.x += a1;
    sim.truePos.y += a2;
  
    const gps = {
      x: sim.truePos.x,
      y: sim.truePos.y
    };

    renderTrue[node.nodeId] = {x: gps.x, y: gps.y};
   
    (node as any)._sim = {
      true: { ...sim.truePos },
      gps,
      ekf: {
        x: a1,
        y: a2
      }
    };
  }
}



export function buildRelativePositions(
  nodeLocations: NodeLocation[],
  originLat: number,
  originLng: number
) {

  const rel: Record<number, Vec2> = {};

  for (const node of nodeLocations) {
    rel[node.nodeId] = gpsToLocal(
      { lat: node.lat, lng: node.lng },
      {lat: originLat, lng: originLng}
    );
  }

  return rel;
}


export const EKFCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [zoom, setZoom] = useState(5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const [showRMSE, setShowRMSE] = useState(false);

  const rmseHistoryRef = useRef<{ kalman: number; gps: number }[]>([]);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = 1.1;
      setZoom(z => e.deltaY < 0 ? z * zoomFactor : z / zoomFactor);
    };

    const handleMouseDown = (e: MouseEvent) => {
      setIsDragging(true);
      lastMouse.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;

      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      lastMouse.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseUp = () => setIsDragging(false);

    canvas.addEventListener("wheel", handleWheel);
    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!renderLocations.length) return;

    let allPoints: Vec2[] = [];

    for (const node of renderLocations) {
      const sim = (node as any)._sim;
      if (!sim) continue;

      allPoints.push(renderTrue[node.nodeId]);
    }

    for (const node of renderLocations) { 
      const gps = gpsToLocal( { lat: node.lat, lng: node.lng }, renderOrigin ); 

      const kalman = gpsToLocal( { lat: node.kalmanLat, lng: node.kalmanLng }, renderOrigin ); 

      allPoints.push(gps, kalman); 
    }

   const center = { 
    x: allPoints.reduce((sum, p) => sum + p.x, 0) / allPoints.length, 
    y: allPoints.reduce((sum, p) => sum + p.y, 0) / allPoints.length, 
      };

    const canvasCenter = {
      x: canvas.width / 2,
      y: canvas.height / 2,
    };

    const toScreen = (p: Vec2) => ({
      x: canvasCenter.x + (p.x - center.x) * zoom + pan.x,
      y: canvasCenter.y - (p.y - center.y) * zoom + pan.y,
    });

    for (const node of renderLocations) {
      const sim = (node as any)._sim;
      if (!sim) continue;

      let sumSqKalman = 0;
      let sumSqGPS = 0;
      let count = 0;

      for (const node of renderLocations) {
        const sim = (node as any)._sim;
        if (!sim) continue;

        const gps = gpsToLocal( { lat: node.lat, lng: node.lng }, renderOrigin ); 

        const kalman = gpsToLocal( { lat: node.kalmanLat, lng: node.kalmanLng }, renderOrigin ); 

        const dxK = renderTrue[node.nodeId].x - kalman.x;
        const dyK = renderTrue[node.nodeId].y - kalman.y;

        const dxG = renderTrue[node.nodeId].x - gps.x;
        const dyG = renderTrue[node.nodeId].y - gps.y;

        sumSqKalman += dxK * dxK + dyK * dyK;
        sumSqGPS += dxG * dxG + dyG * dyG;

        count++;
      }

      if (count > 0) {
        const rmseKalman = Math.sqrt(sumSqKalman / count);
        const rmseGPS = Math.sqrt(sumSqGPS / count);

        rmseHistoryRef.current.push({
          kalman: rmseKalman,
          gps: rmseGPS
        });

        if (rmseHistoryRef.current.length > 300) {
          rmseHistoryRef.current.shift();
        }
      }

      const gps = gpsToLocal( { lat: node.lat, lng: node.lng }, renderOrigin );
      const kalman = gpsToLocal( { lat: node.kalmanLat, lng: node.kalmanLng }, renderOrigin );

      const t = toScreen(sim.true);
      const g = toScreen(gps);
      const k = toScreen(kalman);

      // ⚪ truth
      ctx.fillStyle = "white";
      ctx.beginPath();
      ctx.arc(t.x, t.y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "white";
      ctx.font = "12px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      ctx.fillText(
        `${node.nodeId}`,
        t.x - 13,
        t.y
      );

      // 🔵 GPS
      ctx.fillStyle = "blue";
      ctx.beginPath();
      ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // 🟢 EKF
      ctx.fillStyle = "green";
      ctx.beginPath();
      ctx.arc(k.x, k.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // 🔴 GPS error
      ctx.strokeStyle = "red";
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(g.x, g.y);
      ctx.stroke();

      // 🟡 EKF error
      ctx.strokeStyle = "yellow";
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(k.x, k.y);
      ctx.stroke();
    }

  }, [zoom, pan, renderLocations]);
  const errorHistoryRef = useRef<Record<number, number[]>>({});
  const styles = {
      container: {
        display: "flex",
        height: "100vh",
        width: "100vw",
        backgroundColor: "#0f172a",
        color: "#f1f5f9",
        fontFamily: "sans-serif",
        overflow: "hidden",
        userSelect: "none" as const,
      },
      sidebar: {
        width: "320px",
        backgroundColor: "#1e293b",
        borderRight: "1px solid #334155",
        padding: "20px",
        boxSizing: "border-box" as const,
        height: "100%",
        overflowY: "auto" as const,
        overflowX: "hidden" as const,
        display: "flex",
        flexDirection: "column" as const,
        gap: "15px",
        zIndex: 10,
        boxShadow: "4px 0 15px rgba(0,0,0,0.3)",
      },
      main: { flex: 1, backgroundColor: "#020617", position: "relative" as const, overflow: "hidden" },
      panel: {
        backgroundColor: "rgba(15, 23, 42, 0.5)",
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid #334155",
        display: "flex",
        flexDirection: "column" as const,
        gap: "8px",
      },
      btn: {
        padding: "8px",
        borderRadius: "4px",
        border: "none",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        gap: "6px",
        fontSize: "11px",
        fontWeight: "bold",
        transition: "0.2s",
      },
      label: {
        fontSize: "10px",
        color: "#94a3b8",
        textTransform: "uppercase" as const,
        letterSpacing: "0.5px",
        fontWeight: "bold",
      },
      inspectorRow: {
        display: "flex",
        justifyContent: "space-between",
        padding: "8px 12px",
        borderBottom: "1px solid #1e293b",
        fontSize: "11px",
        fontFamily: "monospace",
      },
    };
  return (
    <div>
      <div
        style={{
          padding: "6px 8px",
          borderTop: "1px solid #334155",
          borderBottom: "1px solid #334155",
          fontSize: "9px",
          fontFamily: "monospace",
          color: "#94a3b8",
          display: "flex",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "16px" }}>
          <span>Current expected Noise: {R} </span>
          <button
            style={{
              ...styles.btn,
              backgroundColor: "transparent",
              color: "#f1f5f9",
              width: "auto"
            }} onClick={()=>handleSetR(renderEKF)}
          >
            <NotebookPen size={12} /> Set R
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "16px" }}>
          <span>Current Trust in Filter: {N}</span>
          <button
            style={{
              ...styles.btn,
              backgroundColor: "transparent",
              color: "#f1f5f9",
              width: "auto"
            }} onClick={()=>handleSetNoise(renderEKF)}
          >
            <NotebookPen size={12} /> Set N
          </button>
        </div>
         <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "16px" }}>
          <span>Current noise std: {sTD} </span>
          <button
            style={{
              ...styles.btn,
              backgroundColor: "transparent",
              color: "#f1f5f9",
              width: "auto"
            }} onClick={()=>handleSetSTD()}>
            <NotebookPen size={12} /> Set STD
          </button>
        </div>
        <button
            onClick={() => setShowRMSE(s => !s)}
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 10
            }}
          >
            Toggle RMSE
          </button>
      </div>
        <div
        style={{
          display: "flex",
          gap: "16px",
          height: "600px", 
        }}
      >
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          style={{ flexShrink: 0 }}
        />
        <div
          style={{
            flex: 1,
            overflowY: "auto", 
            fontFamily: "monospace",
            fontSize: "12px",
            borderLeft: "1px solid #334155",
            paddingLeft: "10px",
          }}
        >

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: "12px",
            }}
          >
            {renderLocations.map((node) => {
              if (!renderEKF) return null;

              const origin = {
                lat: renderOrigin.lat,
                lng: renderOrigin.lng,
              };

              const gps = gpsToLocal(
                { lat: node.lat, lng: node.lng },
                origin
              );

              const kalman = gpsToLocal(
                { lat: node.kalmanLat, lng: node.kalmanLng },
                origin
              );
             

  
              let dx = 0; let dy = 0; let dist = 0;
              let dx2 = 0; let dy2 = 0; let dist2 = 0;
              let trueX = 0; let trueY = 0;

              const truePos = renderTrue[node.nodeId]
              if (truePos) {
                trueX = truePos.x; trueY = truePos.y
                dx = truePos.x - gps.x;
                dy = truePos.y - gps.y;
                dx2 = truePos.x - kalman.x;
                dy2 = truePos.y - kalman.y;
                }

              dist = Math.sqrt(dx * dx + dy * dy);
              dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

              if (!errorHistoryRef.current[node.nodeId]) {
                errorHistoryRef.current[node.nodeId] = [];
              }

              const history = errorHistoryRef.current[node.nodeId];
              history.push(dist);
              if (history.length > 100) history.shift();

              const maxScale = 50; //SCALE IF NEEDED
              const points = history
                .map((v, i) => {
                  const x = (i / 100) * 100;
                  const y = 100 - Math.min(v / maxScale, 1) * 100;
                  return `${x},${y}`;
                })
                .join(" ");

              const color =
                dist < 30 ? "#22c55e" : dist < 100 ? "#f59e0b" : "#ef4444";

              return (
                <div
                  key={node.nodeId}
                  style={{
                    background: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "8px",
                    padding: "10px",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                  }}
                >
                  <div
                    style={{
                      fontWeight: "bold",
                      marginBottom: "6px",
                      color: "#e2e8f0",
                    }}
                  >
                    Node {node.nodeId}
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                    GPS:
                    <div>
                      ({gps.x.toFixed(1)}, {gps.y.toFixed(1)})
                    </div>
                    Kalman:
                    <div>
                      ({kalman.x.toFixed(1)}, {kalman.y.toFixed(1)})
                    </div>
                    True Position:
                    <div>
                      ({trueX.toFixed(1)}, {trueY.toFixed(1)})
                    </div> 
                  </div>
                  <div style={{ fontSize: "13px", color: "#adbdd3", marginTop: "5px" }}>GPS diff</div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontWeight: "bold",
                      color,
                    }}>Δ {dist.toFixed(1)} m
                  </div>
                   <div style={{ fontSize: "13px", color: "#adbdd3", marginTop: "5px" }}>Kalman diff</div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontWeight: "bold",
                      color,
                    }}>Δ {dist2.toFixed(1)} m
                  </div>
                </div>
              );
            })}
            {showRMSE && (
            <div
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                width: 300,
                height: 150,
                background: "rgba(0,0,0,0.8)",
                border: "1px solid #444",
                padding: 8
              }}
            >
            <canvas
              width={280}
              height={120}
              ref={(canvas) => {
                if (!canvas) return;

                const ctx = canvas.getContext("2d");
                if (!ctx) return;

                const data = rmseHistoryRef.current;
                if (!data.length) return;

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                // 🔥 correct max across BOTH series
                const max = Math.max(
                  ...data.map(d => Math.max(d.kalman, d.gps)),
                  1
                );

                // 🔵 GPS line
                ctx.strokeStyle = "blue";
                ctx.beginPath();

                data.forEach((d, i) => {
                  const x = (i / data.length) * canvas.width;
                  const y = canvas.height - (d.gps / max) * canvas.height;

                  if (i === 0) ctx.moveTo(x, y);
                  else ctx.lineTo(x, y);
                });

                ctx.stroke();

                // 🟢 Kalman line
                ctx.strokeStyle = "lime";
                ctx.beginPath();

                data.forEach((d, i) => {
                  const x = (i / data.length) * canvas.width;
                  const y = canvas.height - (d.kalman / max) * canvas.height;

                  if (i === 0) ctx.moveTo(x, y);
                  else ctx.lineTo(x, y);
                });

                ctx.stroke();

                // 📊 labels
                const last = data[data.length - 1];

                ctx.fillStyle = "white";
                ctx.font = "10px monospace";

                ctx.fillText(`GPS: ${last.gps.toFixed(2)} m`, 5, 12);
                ctx.fillText(`EKF: ${last.kalman.toFixed(2)} m`, 5, 24);

                // optional: improvement %
                if (last.gps > 0) {
                  const improvement = (1 - last.kalman / last.gps) * 100;
                  ctx.fillText(`Δ: ${improvement.toFixed(1)}%`, 5, 36);
                }
              }}
            />
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
};