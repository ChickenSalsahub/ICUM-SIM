import React, {  useRef, useEffect, useState } from "react";
import { FusedRecord } from "./logic/CloudBackend";
import {
	NotebookPen,
} from "lucide-react";

export function getLatestPerNode(data: FusedRecord[]): Record<number, any> {
    const latest: Record<number, FusedRecord> = {};
    let origin =  undefined;

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
    }

    return [{positions, origin}];
}

let R = 25; let N = 0.1;

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

export class GlobalTransformEKF {
  x: number[]; // [px, py, vx, vy]
  P: number[][];
  Q: number[][];
  R: number[][];

  constructor() {
    this.x = [0, 0, 0, 0];

    this.P = scaleMatrix(identity(4), 100);
    this.Q = scaleMatrix(identity(4), N);

    this.R = [
      [R, 0],
      [0, R],
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
    const [px, py, vx, vy] = this.x;

    this.x[0] = px + vx * dt;
    this.x[1] = py + vy * dt;

   const F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];

    this.P = add(mul(mul(F, this.P), transpose(F)), this.Q);

  }

  update(z: { x: number; y: number }) {
    const H = [
      [1, 0, 0, 0],
      [0, 1, 0, 0]
    ];

    const hx = [this.x[0], this.x[1]];

    const y = [
      z.x - hx[0],
      z.y - hx[1]
    ];

    const S = add(
      mul(mul(H, this.P), transpose(H)),
      this.R
    )
    

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
    
    this.P = mul(sub(I, mul(K, H)), this.P);
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
    x: dLng * metersPerDegLng,
    y: dLat * metersPerDegLat,
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

export function runEKFStep(
  ekfMap: Record<number, GlobalTransformEKF>,
  locations: NodeLocation[],
  dt: number,
  originLat: number,
  originLng: number
){

  for (const node of locations) {
    if(node.lat) {
      if (!ekfMap[node.nodeId]) {
      ekfMap[node.nodeId] = new GlobalTransformEKF();
      }

      const ekf = ekfMap[node.nodeId];

      ekf.predict(dt);

      const enu = gpsToLocal({ lat: node.lat, lng: node.lng }, { lat: originLat, lng: originLng });

      ekf.update(enu);

      const latLng = enuToLatLng(
        { x: ekf.x[0], y: ekf.x[1] },
        { lat: originLat, lng: originLng }
      );

      locations[node.nodeId - 1] = {
        nodeId: node.nodeId,
        kalmanLat: latLng.lat,
        kalmanLng: latLng.lng,
        lat: node.lat,
        lng: node.lng
      };
    }
  }

  renderLocations = locations; 
  renderEKF = ekfMap;
  renderOrigin = { lat: originLat, lng: originLng }
  console.log(locations, ekfMap)
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

    return (

      
    ) => {
      <div>
        asd
      </div>
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

  // 🔥 Collect all points (GPS + Kalman)
  let allPoints: Vec2[] = [];

  for (const node of renderLocations) {
    const gps = gpsToLocal(
      { lat: node.lat, lng: node.lng },
      renderOrigin
    );

    const kalman = gpsToLocal(
      { lat: node.kalmanLat, lng: node.kalmanLng },
      renderOrigin
    );

    allPoints.push(gps, kalman);
  }

  // 🔥 Compute center
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

  // 🎨 Draw nodes
  for (const node of renderLocations) {
    const gps = gpsToLocal(
      { lat: node.lat, lng: node.lng },
      renderOrigin
    );

    const kalman = gpsToLocal(
      { lat: node.kalmanLat, lng: node.kalmanLng },
      renderOrigin
    );

    const gpsScreen = toScreen(gps);
    const kalmanScreen = toScreen(kalman);

    // 🔵 GPS point
    ctx.fillStyle = "blue";
    ctx.beginPath();
    ctx.arc(gpsScreen.x, gpsScreen.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // 🟢 Kalman point
    ctx.fillStyle = "green";
    ctx.beginPath();
    ctx.arc(kalmanScreen.x, kalmanScreen.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // 🔴 Residual line
    ctx.strokeStyle = "red";
    ctx.beginPath();
    ctx.moveTo(kalmanScreen.x, kalmanScreen.y);
    ctx.lineTo(gpsScreen.x, gpsScreen.y);
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
        {/* Column 1 */}
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

        {/* Column 2 */}
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
      </div>
        <div
        style={{
          display: "flex",
          gap: "16px",
          height: "600px", // 👈 match canvas height
        }}
      >
        {/* Canvas */}
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          style={{ flexShrink: 0 }}
        />

        {/* Debug panel */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",     // 👈 internal scroll
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
      lat: renderLocations[0].lat,
      lng: renderLocations[0].lng,
    };

    const gps = gpsToLocal(
      { lat: node.lat, lng: node.lng },
      origin
    );

    const kalman = gpsToLocal(
      { lat: node.kalmanLat, lng: node.kalmanLng },
      origin
    );

    const dx = gps.x - kalman.x;
    const dy = gps.y - kalman.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (!errorHistoryRef.current[node.nodeId]) {
      errorHistoryRef.current[node.nodeId] = [];
    }

    const history = errorHistoryRef.current[node.nodeId];
    history.push(dist);
    if (history.length > 100) history.shift();

    // 🔥 fixed scale (important)
    const maxScale = 50; // meters (adjust as needed)
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
        {/* Header */}
        <div
          style={{
            fontWeight: "bold",
            marginBottom: "6px",
            color: "#e2e8f0",
          }}
        >
          Node {node.nodeId}
        </div>

        {/* Values */}
        <div style={{ fontSize: "11px", color: "#94a3b8" }}>
          GPS:
          <div>
            ({gps.x.toFixed(1)}, {gps.y.toFixed(1)})
          </div>

          Kalman:
          <div>
            ({kalman.x.toFixed(1)}, {kalman.y.toFixed(1)})
          </div>
        </div>

        {/* Error */}
        <div
          style={{
            marginTop: "6px",
            fontWeight: "bold",
            color,
          }}
        >
          Δ {dist.toFixed(1)} m
        </div>

        {/* Sparkline */}
        <svg width="100%" height="50" style={{ marginTop: "6px" }}>
          <polyline
            fill="none"
            stroke="#38bdf8"
            strokeWidth="2"
            points={points}
          />
        </svg>
      </div>
    );
  })}
</div>
        </div>
      </div>
    </div>
  )
};