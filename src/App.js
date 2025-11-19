import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, Wifi, Activity, MapPin, Plus, Trash2, Zap, Database, XCircle } from 'lucide-react';

// ==========================================
// 1. DATA STRUCTURES
// ==========================================

class NodeEntity {
  constructor(id, type, x, y) {
    this.id = id;
    this.type = type; // 'HARDWARE_GW' (Purple) | 'TRACKER' (Green/Blue)
    this.x = x;
    this.y = y;
    
    // Physics
    this.targetX = x;
    this.targetY = y;
    this.isMoving = type === 'TRACKER'; // Default move state

    // State
    this.battery = Math.floor(Math.random() * 40) + 60; // 60-100%
    this.role = type === 'HARDWARE_GW' ? 'ROOT' : 'IDLE'; 
    this.isolationTimer = 0;
    this.clusterId = -1;
  }

  updatePhysics(dt, config) {
    // BUG FIX: Respect the isMoving flag even if Isolated
    if (!this.isMoving) return; 

    const dist = Math.sqrt(Math.pow(this.targetX - this.x, 2) + Math.pow(this.targetY - this.y, 2));
    if (dist < 10) {
      // Pick new waypoint
      this.targetX = Math.random() * 1100 + 50;
      this.targetY = Math.random() * 700 + 50;
    } else {
      const moveStep = config.movingSpeed * 20; 
      this.x += ((this.targetX - this.x) / dist) * moveStep;
      this.y += ((this.targetY - this.y) / dist) * moveStep;
    }
  }
}

// ==========================================
// 2. THE REACT COMPONENT
// ==========================================

const styles = {
  container: { display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0f172a', color: '#f1f5f9', fontFamily: 'sans-serif', overflow: 'hidden' },
  sidebar: { width: '320px', backgroundColor: '#1e293b', borderRight: '1px solid #334155', padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px', zIndex: 10, boxShadow: '4px 0 15px rgba(0,0,0,0.3)' },
  main: { flex: 1, backgroundColor: '#020617', position: 'relative', overflow: 'hidden' },
  panel: { backgroundColor: 'rgba(15, 23, 42, 0.5)', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' },
  btn: { padding: '8px', borderRadius: '4px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', gap: '6px', fontSize: '11px', fontWeight: 'bold', transition: '0.2s' },
  label: { fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 'bold' },
  logPanel: { position: 'absolute', bottom: '20px', right: '20px', width: '400px', height: '300px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', zIndex: 20 },
  logHeader: { padding: '10px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', borderTopLeftRadius: '8px', borderTopRightRadius: '8px' },
  logBody: { flex: 1, overflowY: 'auto', padding: '10px', fontFamily: 'monospace', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' },
  logEntry: { padding: '4px', borderBottom: '1px solid #1e293b', color: '#94a3b8' }
};

const PIXELS_PER_METER = 20;

const App = () => {
  // --- STATE ---
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [logs, setLogs] = useState([]); // The "Database"
  const [showLogs, setShowLogs] = useState(false);
  const [tick, setTick] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  
  const [config, setConfig] = useState({
    uwbRange: 12,
    isolationTimeout: 5, 
    movingSpeed: 0.15,
    showRange: false,
  });

  // --- INIT ---
  useEffect(() => {
    const initial = [
      new NodeEntity(1, 'HARDWARE_GW', 200, 200),
      new NodeEntity(2, 'TRACKER', 250, 250),
      new NodeEntity(3, 'TRACKER', 300, 200),
    ];
    setNodes(initial);
  }, []);

  // --- LOGGING HELPER ---
  const addLog = useCallback((msg, type = 'INFO') => {
    const time = new Date().toLocaleTimeString().split(' ')[0];
    setLogs(prev => [{ time, msg, type }, ...prev].slice(0, 50)); // Keep last 50
  }, []);

  // --- ENGINE ---
  const updateSimulation = useCallback(() => {
    setTick(t => t + 1);
    const rangePx = config.uwbRange * PIXELS_PER_METER;

    // 1. MOVE NODES
    nodes.forEach(n => n.updatePhysics(0.05, config));

    // 2. BUILD ADJACENCY GRAPH
    const adjList = {};
    nodes.forEach(n => adjList[n.id] = []);
    const activeLinks = [];

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i];
        const n2 = nodes[j];
        const dist = Math.sqrt(Math.pow(n2.x - n1.x, 2) + Math.pow(n2.y - n1.y, 2));

        if (dist <= rangePx) {
          activeLinks.push({ source: n1, target: n2 });
          adjList[n1.id].push(n2.id);
          adjList[n2.id].push(n1.id);
        }
      }
    }
    setLinks(activeLinks);

    // 3. CLUSTER ANALYSIS
    const visited = new Set();
    const clusters = [];

    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        const cluster = [];
        const queue = [node.id];
        visited.add(node.id);

        while(queue.length > 0) {
          const currId = queue.shift();
          const currNode = nodes.find(n => n.id === currId);
          cluster.push(currNode);
          
          adjList[currId].forEach(neighborId => {
            if (!visited.has(neighborId)) {
              visited.add(neighborId);
              queue.push(neighborId);
            }
          });
        }
        clusters.push(cluster);
      }
    });

    // 4. ELECTION LOGIC (The Thesis Core)
    clusters.forEach(cluster => {
      const hasHardwareGw = cluster.some(n => n.type === 'HARDWARE_GW');

      if (hasHardwareGw) {
        // Connected to Internet via Hardware
        cluster.forEach(n => {
          if (n.type === 'HARDWARE_GW') {
            n.role = 'ROOT'; // Always Root
          } else {
            // DEMOTION LOGIC: If I was a leader, I am now just a relay
            if (n.role === 'LEADER') addLog(`Node ${n.id} demoted: Found Hardware GW`, 'WARN');
            n.role = 'RELAY'; 
          }
          n.isolationTimer = 0;
          
          // SIMULATE DATA UPLOAD LOG
          if (Math.random() > 0.98) {
             addLog(`ID:${n.id} uploaded packet via HW_GW`, 'SUCCESS');
          }
        });
      } else {
        // "Dark Cluster"
        if (cluster.length === 1) {
          const n = cluster[0];
          n.role = 'ISOLATED';
          n.isolationTimer += 0.05;
          
          // If Panic Timer hits, we upload via LTE
          if (n.isolationTimer > config.isolationTimeout && Math.random() > 0.98) {
             addLog(`ID:${n.id} (ISOLATED) uploaded via Emergency LTE`, 'ERROR');
          }
        } else {
          // ELECTION TIME
          let leader = cluster[0];
          cluster.forEach(n => {
            if (n.battery > leader.battery) leader = n;
            n.isolationTimer = 0;
          });

          cluster.forEach(n => {
            if (n.id === leader.id) {
              if (n.role !== 'LEADER') addLog(`Node ${n.id} elected Leader (Bat: ${n.battery}%)`, 'INFO');
              n.role = 'LEADER'; 
              
              // SIMULATE DATA UPLOAD
              if (Math.random() > 0.98) {
                addLog(`Cluster Data uploaded via Elected Leader ${n.id}`, 'SUCCESS');
              }
            } else {
              n.role = 'RELAY';
            }
          });
        }
      }
    });

  }, [nodes, config, addLog]);

  useEffect(() => {
    let interval;
    if (isPlaying) interval = setInterval(updateSimulation, 50);
    return () => clearInterval(interval);
  }, [isPlaying, updateSimulation]);

  // --- ACTIONS ---
  const spawn = (type) => {
    const n = new NodeEntity(Date.now(), type, Math.random() * 1000 + 50, Math.random() * 700 + 50);
    setNodes(prev => [...prev, n]);
    addLog(`Spawned new ${type}`);
  };
  const clearType = (type) => {
    setNodes(prev => prev.filter(n => n.type !== type));
    addLog(`Cleared all ${type}s`);
  };
  const nukeAll = () => {
    setNodes([]);
    addLog(`SYSTEM WIPE: All nodes destroyed`, 'WARN');
  };
  const toggleMove = (id) => {
    const n = nodes.find(x => x.id === id);
    if(n) {
      n.isMoving = !n.isMoving;
      // Reset waypoint to current location if stopping so it doesn't jump later
      if (!n.isMoving) {
        n.targetX = n.x;
        n.targetY = n.y;
      }
    }
  };

  // --- RENDER HELPERS ---
  const getNodeColor = (n) => {
    if (n.role === 'ISOLATED' && n.isolationTimer > config.isolationTimeout) return '#ef4444'; // Red (Panic)
    if (n.role === 'ISOLATED') return '#f59e0b'; // Yellow (Warning)
    if (n.type === 'HARDWARE_GW') return '#a855f7'; // Purple
    if (n.role === 'LEADER') return '#ec4899'; // Pink (Elected)
    return '#22c55e'; // Green (Standard)
  };

  return (
    <div style={styles.container}>
      {/* SIDEBAR */}
      <div style={styles.sidebar}>
        <div>
          <h1 style={{margin:0, color:'#38bdf8', fontSize:'22px', fontWeight:'900'}}>CLUSTER SIM v4</h1>
          <p style={{margin:0, color:'#64748b', fontSize:'11px'}}>Full Stack Validation</p>
        </div>

        {/* CONTROLS */}
        <div style={styles.panel}>
          <span style={styles.label}>Spawn</span>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px'}}>
            <button style={{...styles.btn, backgroundColor:'#334155'}} onClick={() => spawn('TRACKER')}>
              <Plus size={14} /> Tracker
            </button>
            <button style={{...styles.btn, backgroundColor:'#334155'}} onClick={() => spawn('HARDWARE_GW')}>
              <Plus size={14} /> HW Gateway
            </button>
          </div>
        </div>

        <div style={styles.panel}>
          <span style={styles.label}>Manage</span>
          <button style={{...styles.btn, backgroundColor:'#475569'}} onClick={() => clearType('TRACKER')}>
            <Trash2 size={14} /> Clear Trackers
          </button>
          <button style={{...styles.btn, backgroundColor:'#475569'}} onClick={() => clearType('HARDWARE_GW')}>
            <Trash2 size={14} /> Clear Gateways
          </button>
          <button style={{...styles.btn, backgroundColor:'#b91c1c'}} onClick={nukeAll}>
            <XCircle size={14} /> NUKE ALL
          </button>
        </div>

        <div style={styles.panel}>
           <button style={{...styles.btn, backgroundColor: showLogs ? '#3b82f6' : '#334155'}} onClick={() => setShowLogs(!showLogs)}>
            <Database size={14} /> {showLogs ? 'Hide Database' : 'Show Database'}
          </button>
        </div>

        <div style={styles.panel}>
          <span style={styles.label}>Config</span>
          <div style={{display:'flex', justifyContent:'space-between'}}>
             <span style={{fontSize:'10px', color:'#cbd5e1'}}>UWB Range</span>
             <span style={{fontSize:'10px', color:'#cbd5e1'}}>{config.uwbRange}m</span>
          </div>
          <input type="range" min="5" max="30" value={config.uwbRange} 
             onChange={e => setConfig({...config, uwbRange: Number(e.target.value)})} />
             
          <label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', marginTop:'5px', cursor:'pointer'}}>
             <input type="checkbox" checked={config.showRange} onChange={e => setConfig({...config, showRange:e.target.checked})} />
             Show Radio Radius
          </label>
        </div>

        <button style={{...styles.btn, backgroundColor: isPlaying ? '#eab308' : '#22c55e', marginTop:'auto', padding:'12px'}} 
          onClick={() => setIsPlaying(!isPlaying)}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />} {isPlaying ? 'PAUSE' : 'RESUME'}
        </button>
      </div>

      {/* CANVAS */}
      <div style={styles.main}>
        <div style={styles.overlay}>
          TICKS: {tick} | NODES: {nodes.length}
        </div>

        {/* DATABASE PANEL */}
        {showLogs && (
          <div style={styles.logPanel}>
             <div style={styles.logHeader}>
                <span style={{color:'white', fontSize:'12px', fontWeight:'bold', display:'flex', alignItems:'center', gap:'6px'}}>
                   <Database size={12} color="#38bdf8"/> CLOUD UPLOAD LOGS
                </span>
                <button onClick={() => setShowLogs(false)} style={{background:'none', border:'none', cursor:'pointer', color:'#94a3b8'}}>✕</button>
             </div>
             <div style={styles.logBody}>
                {logs.length === 0 && <span style={{color:'#475569', textAlign:'center', marginTop:'20px'}}>No Data Packets Yet...</span>}
                {logs.map((l, i) => (
                   <div key={i} style={{...styles.logEntry, color: l.type === 'SUCCESS' ? '#4ade80' : (l.type === 'WARN' ? '#fbbf24' : (l.type === 'ERROR' ? '#f87171' : '#94a3b8'))}}>
                      <span style={{opacity:0.5}}>[{l.time}]</span> {l.msg}
                   </div>
                ))}
             </div>
          </div>
        )}

        <svg width="100%" height="100%" viewBox="0 0 1200 800">
           <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />

          {config.showRange && nodes.map(n => (
            <circle key={`r-${n.id}`} cx={n.x} cy={n.y} r={config.uwbRange * PIXELS_PER_METER} 
              fill="none" stroke="#334155" strokeDasharray="4 4" opacity="0.3" />
          ))}

          {links.map((l, i) => {
            const isElectedLink = l.source.role === 'LEADER' || l.target.role === 'LEADER';
            const color = isElectedLink ? '#ec4899' : '#22c55e';
            return (
              <g key={i}>
                <line x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} stroke={color} strokeOpacity="0.3" strokeWidth="1" />
                <line x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} stroke={color} strokeOpacity="0.6" strokeWidth="2" strokeDasharray="4 4">
                  <animate attributeName="stroke-dashoffset" from="100" to="0" dur="0.5s" repeatCount="indefinite" />
                </line>
              </g>
            )
          })}

          {nodes.map(n => {
            const color = getNodeColor(n);
            let Icon = Activity;
            if (n.type === 'HARDWARE_GW') Icon = Wifi;
            if (n.role === 'LEADER') Icon = Zap;
            if (n.role === 'ISOLATED') Icon = n.isolationTimer > config.isolationTimeout ? Wifi : Activity;

            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} onClick={() => toggleMove(n.id)} style={{cursor:'pointer'}}>
                
                {n.role === 'ISOLATED' && n.isolationTimer > config.isolationTimeout && (
                   <circle r="30" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.5">
                     <animate attributeName="r" from="20" to="50" dur="1s" repeatCount="indefinite" />
                     <animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite" />
                   </circle>
                )}

                <circle r="18" fill="#0f172a" stroke={color} strokeWidth="3" />
                
                <foreignObject x="-10" y="-10" width="20" height="20" style={{pointerEvents:'none'}}>
                   <div style={{display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color: color}}>
                     <Icon size={14} />
                   </div>
                </foreignObject>

                <text y="32" textAnchor="middle" fill={color} fontSize="10" fontWeight="bold" fontFamily="monospace">
                  {n.type === 'HARDWARE_GW' ? 'HW_GW' : (n.role === 'LEADER' ? 'ELECTED' : `ID:${n.id}`)}
                </text>
                
                <text y="44" textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace">
                  {n.isMoving ? 'MOVING' : 'STATIC'}
                </text>

                <g transform="translate(12, -20)">
                   <rect x="0" y="0" width="14" height="8" rx="2" fill="#1e293b" stroke="#475569" />
                   <rect x="2" y="2" width={Math.max(0, (n.battery/100)*10)} height="4" rx="1" fill={n.battery > 30 ? '#22c55e' : '#ef4444'} />
                   <text x="18" y="8" fill="#64748b" fontSize="8">{n.battery}%</text>
                </g>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  );
};

export default App;