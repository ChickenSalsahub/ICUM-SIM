import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, Wifi, Activity, Plus, Trash2, Zap, Database, XCircle, Search, GripHorizontal, Layers } from 'lucide-react';

// ==========================================
// 1. UI COMPONENT: DRAGGABLE WINDOW
// ==========================================

const DraggableWindow = ({ id, title, icon: Icon, children, initialX, initialY, onClose, onFocus, zIndex }) => {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e) => {
    e.stopPropagation();
    onFocus(id); // Bring to front
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      setPos({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y
      });
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div 
      onMouseDown={() => onFocus(id)}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: '300px', backgroundColor: 'rgba(15, 23, 42, 0.95)',
        backdropFilter: 'blur(10px)', border: '1px solid #38bdf8', borderRadius: '8px',
        boxShadow: '0 10px 40px rgba(0,0,0,0.6)', zIndex: zIndex, overflow: 'hidden', display: 'flex', flexDirection: 'column'
      }}>
      {/* Header */}
      <div 
        onMouseDown={handleMouseDown}
        style={{
          backgroundColor: 'rgba(56, 189, 248, 0.15)', padding: '10px', borderBottom: '1px solid #334155',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'grab', userSelect: 'none'
        }}
      >
        <span style={{color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px'}}>
           <Icon size={12} /> {title}
        </span>
        <div style={{display:'flex', gap:'8px', alignItems:'center'}}>
           <GripHorizontal size={12} color="#64748b" />
           <button onClick={(e) => { e.stopPropagation(); onClose(id); }} style={{background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontWeight:'bold'}}>✕</button>
        </div>
      </div>
      {/* Content */}
      <div style={{maxHeight: '300px', overflowY: 'auto', padding: '0'}}>
        {children}
      </div>
    </div>
  );
};

// ==========================================
// 2. DATA STRUCTURES
// ==========================================

class NodeEntity {
  constructor(id, type, x, y) {
    this.id = id;
    this.type = type; // 'HARDWARE_GW' | 'TRACKER'
    this.x = x;
    this.y = y;
    
    // Physics
    this.targetX = x;
    this.targetY = y;
    this.isMoving = type === 'TRACKER'; 
    
    // State
    this.battery = Math.floor(Math.random() * 40) + 60; 
    this.role = type === 'HARDWARE_GW' ? 'ROOT' : 'IDLE'; 
    this.isolationTimer = 0;
    this.lastReportTime = 0; // For throttling logs
    
    // Routing
    this.nextHop = null; 
    this.hopsToGw = 999;
  }

  // Updates physics only if NOT being dragged (handled by React state now)
  updatePhysics(dt, config, isDragging) {
    if (isDragging) return; // Mouse owns X/Y
    if (!this.isMoving) return; 

    const dist = Math.sqrt(Math.pow(this.targetX - this.x, 2) + Math.pow(this.targetY - this.y, 2));
    
    if (dist < 10) {
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
// 3. MAIN APP
// ==========================================

const styles = {
  container: { display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0f172a', color: '#f1f5f9', fontFamily: 'sans-serif', overflow: 'hidden', userSelect: 'none' },
  sidebar: { width: '320px', backgroundColor: '#1e293b', borderRight: '1px solid #334155', padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px', zIndex: 10, boxShadow: '4px 0 15px rgba(0,0,0,0.3)' },
  main: { flex: 1, backgroundColor: '#020617', position: 'relative', overflow: 'hidden' },
  panel: { backgroundColor: 'rgba(15, 23, 42, 0.5)', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' },
  btn: { padding: '8px', borderRadius: '4px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', gap: '6px', fontSize: '11px', fontWeight: 'bold', transition: '0.2s' },
  label: { fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 'bold' },
  inspectorRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #1e293b', fontSize: '11px', fontFamily: 'monospace' },
};

const PIXELS_PER_METER = 20;
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

const App = () => {
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [logs, setLogs] = useState([]); 
  const [showLogs, setShowLogs] = useState(false);
  const [tick, setTick] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  
  // Window Management
  const [openWindows, setOpenWindows] = useState([]); // Array of IDs
  const [windowOrder, setWindowOrder] = useState([]); // Array of IDs for Z-Index
  
  // Drag Management
  const [draggedNodeId, setDraggedNodeId] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const svgRef = useRef(null);

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
      new NodeEntity(2, 'TRACKER', 400, 400),
      new NodeEntity(3, 'TRACKER', 300, 300),
    ];
    setNodes(initial);
  }, []);

  const addLog = useCallback((msg, type = 'INFO') => {
    const time = new Date().toLocaleTimeString().split(' ')[0];
    setLogs(prev => [{ time, msg, type }, ...prev].slice(0, 50)); 
  }, []);

  // --- WINDOW MANAGERS ---
  const openNodeWindow = (id) => {
    if (!openWindows.includes(id)) {
      setOpenWindows(prev => [...prev, id]);
      setWindowOrder(prev => [...prev, id]); // Add to top
    } else {
      focusWindow(id);
    }
  };

  const closeNodeWindow = (id) => {
    setOpenWindows(prev => prev.filter(w => w !== id));
    setWindowOrder(prev => prev.filter(w => w !== id));
  };

  const focusWindow = (id) => {
    setWindowOrder(prev => [...prev.filter(w => w !== id), id]);
  };

  // --- MOUSE HANDLERS (SMOOTH DRAG) ---
  const handleMouseDown = (e, nodeId) => {
    e.stopPropagation(); 
    if (e.button !== 0) return; 

    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      setDraggedNodeId(nodeId);
      setDragOffset({ x: mouseX - node.x, y: mouseY - node.y });
    }
  };

  const handleMouseMove = (e) => {
    if (draggedNodeId === null) return;

    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // INSTANT UPDATE for smooth animation
    setNodes(prevNodes => prevNodes.map(n => {
      if (n.id === draggedNodeId) {
        n.x = mouseX - dragOffset.x;
        n.y = mouseY - dragOffset.y;
        n.targetX = n.x; // Sync target so it doesn't snap back
        n.targetY = n.y;
        return n; 
      }
      return n;
    }));
  };

  const handleMouseUp = () => {
    setDraggedNodeId(null);
  };

  // --- ROUTING TRACER ---
  const tracePath = (nodeId, nodeList) => {
    let path = [];
    let curr = nodeList.find(n => n.id === nodeId);
    let hops = 0;
    while (curr && curr.nextHop && hops < 10) {
      path.push(curr.id);
      curr = nodeList.find(n => n.id === curr.nextHop);
      hops++;
    }
    if (curr && (curr.type === 'HARDWARE_GW' || curr.role === 'LEADER')) path.push(curr.id); 
    return path;
  };

  // --- SIMULATION ENGINE ---
  const updateSimulation = useCallback(() => {
    setTick(t => t + 1);
    const rangePx = config.uwbRange * PIXELS_PER_METER;

    // 1. PHYSICS (Skip dragged node)
    nodes.forEach(n => n.updatePhysics(0.05, config, n.id === draggedNodeId));

    // 2. GRAPH BUILD
    const adjList = {};
    nodes.forEach(n => { adjList[n.id] = []; n.nextHop = null; n.hopsToGw = 999; });
    const activeLinks = [];

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i];
        const n2 = nodes[j];
        const dist = Math.sqrt(Math.pow(n2.x - n1.x, 2) + Math.pow(n2.y - n1.y, 2));
        if (dist <= rangePx) {
          activeLinks.push({ source: n1, target: n2, dist });
          adjList[n1.id].push(n2.id);
          adjList[n2.id].push(n1.id);
        }
      }
    }
    setLinks(activeLinks);

    // 3. ROUTING (BFS)
    const queue = [];
    nodes.forEach(n => {
      if (n.type === 'HARDWARE_GW' || n.role === 'LEADER') {
        n.hopsToGw = 0;
        queue.push(n.id);
      }
    });

    while (queue.length > 0) {
      const currId = queue.shift();
      const currNode = nodes.find(n => n.id === currId);
      const neighbors = adjList[currId] || [];
      
      neighbors.forEach(nId => {
        const neighbor = nodes.find(n => n.id === nId);
        if (neighbor.hopsToGw > currNode.hopsToGw + 1) {
          neighbor.hopsToGw = currNode.hopsToGw + 1;
          neighbor.nextHop = currId;
          queue.push(nId);
        }
      });
    }

    // 4. CLUSTERS & LOGIC
    const visited = new Set();
    const clusters = [];
    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        const cluster = [];
        const q = [node.id];
        visited.add(node.id);
        while(q.length > 0) {
          const cid = q.shift();
          cluster.push(nodes.find(n => n.id === cid));
          adjList[cid].forEach(nid => { if(!visited.has(nid)) { visited.add(nid); q.push(nid); } });
        }
        clusters.push(cluster);
      }
    });

    const now = Date.now();

    clusters.forEach(cluster => {
      const hasHardwareGw = cluster.some(n => n.type === 'HARDWARE_GW');
      if (hasHardwareGw) {
        cluster.forEach(n => {
          if (n.type === 'HARDWARE_GW') n.role = 'ROOT';
          else {
            if (n.role === 'LEADER') addLog(`Node ${n.id} Demoted (Found GW)`, 'WARN');
            n.role = 'RELAY';
          }
          n.isolationTimer = 0;
        });
      } else {
         if (cluster.length === 1) {
           const n = cluster[0];
           n.role = 'ISOLATED';
           n.isolationTimer += 0.05;
           if(n.isolationTimer > config.isolationTimeout && Math.random() > 0.99) {
              addLog(`ID:${n.id} Emergency Upload (LTE)`, 'ERROR');
           }
         } else {
           let leader = cluster[0];
           cluster.forEach(n => { if(n.battery > leader.battery) leader = n; n.isolationTimer = 0; });
           cluster.forEach(n => {
             if(n.id === leader.id) {
               if(n.role !== 'LEADER') addLog(`Node ${n.id} Elected Leader`, 'INFO');
               n.role = 'LEADER';
             } else n.role = 'RELAY';
           });
         }
      }
    });

    // 5. LOG STREAMING
    nodes.forEach(n => {
      if (n.isMoving && n.hopsToGw < 999) {
         if (now - n.lastReportTime > 1500) {
            const path = tracePath(n.id, nodes);
            const pathStr = path.map(id => {
                const node = nodes.find(x => x.id === id);
                return node.type === 'HARDWARE_GW' ? `HW_GW:${id}` : `ID:${id}`;
            }).join(' → ');
            
            if (path.length > 0) {
               addLog(`POS_UPDATE: ${pathStr}`, 'SUCCESS');
               n.lastReportTime = now;
            }
         }
      }
    });

  }, [nodes, config, addLog, draggedNodeId]); 

  useEffect(() => {
    let interval;
    if (isPlaying) interval = setInterval(updateSimulation, 50);
    return () => clearInterval(interval);
  }, [isPlaying, updateSimulation]);

  // --- ACTIONS ---
  
  // *** SEQUENTIAL ID FIX IS HERE ***
  const spawn = (type) => {
    // Find Max ID
    const maxId = nodes.length > 0 ? Math.max(...nodes.map(n => n.id)) : 0;
    const nextId = maxId + 1;
    
    const n = new NodeEntity(nextId, type, Math.random() * 1000 + 50, Math.random() * 700 + 50);
    setNodes(prev => [...prev, n]);
    addLog(`Spawned ${type} (ID: ${nextId})`);
  };

  const clearType = (type) => {
    setNodes(prev => prev.filter(n => n.type !== type));
    addLog(`Cleared ${type}s`);
    setOpenWindows([]); 
  };
  const nukeAll = () => {
    setNodes([]);
    setOpenWindows([]);
    addLog(`SYSTEM WIPE`, 'WARN');
  };
  const toggleMove = (id) => {
    const n = nodes.find(x => x.id === id);
    if(n) {
       n.isMoving = !n.isMoving;
       if (!n.isMoving) { n.targetX = n.x; n.targetY = n.y; }
    }
  };

  const getNodeColor = (n) => {
    if (n.role === 'ISOLATED' && n.isolationTimer > config.isolationTimeout) return '#ef4444'; 
    if (n.role === 'ISOLATED') return '#f59e0b'; 
    if (n.type === 'HARDWARE_GW') return '#a855f7'; 
    if (n.role === 'LEADER') return '#ec4899'; 
    return '#22c55e'; 
  };

  return (
    <div style={styles.container} onMouseUp={handleMouseUp} onMouseMove={handleMouseMove}>
      {/* SIDEBAR */}
      <div style={styles.sidebar}>
        <div>
          <h1 style={{margin:0, color:'#38bdf8', fontSize:'22px', fontWeight:'900'}}>SIMULATOR v9</h1>
          <p style={{margin:0, color:'#64748b', fontSize:'11px'}}>Clean IDs & Smooth Drag</p>
        </div>

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
          <input type="range" min="5" max="30" value={config.uwbRange} 
             onChange={e => setConfig({...config, uwbRange: Number(e.target.value)})} style={{width:'100%'}} />
          <span style={{fontSize:'10px', color:'#cbd5e1'}}>Range: {config.uwbRange}m</span>
          <label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', marginTop:'5px', cursor:'pointer'}}>
             <input type="checkbox" checked={config.showRange} onChange={e => setConfig({...config, showRange:e.target.checked})} />
             Show Radius
          </label>
        </div>

        <button style={{...styles.btn, backgroundColor: isPlaying ? '#eab308' : '#22c55e', marginTop:'auto', padding:'12px'}} 
          onClick={() => setIsPlaying(!isPlaying)}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />} {isPlaying ? 'PAUSE' : 'RESUME'}
        </button>
      </div>

      {/* CANVAS */}
      <div style={styles.main}>
        <div style={{position:'absolute', top:'15px', left:'15px', color:'#64748b', fontSize:'12px', fontFamily:'monospace'}}>
          TICKS: {tick} | NODES: {nodes.length}
        </div>

        {/* RENDER ALL OPEN INSPECTOR WINDOWS */}
        {openWindows.map((id) => {
           const node = nodes.find(n => n.id === id);
           if (!node) return null;
           const zIndex = windowOrder.indexOf(id) + 20; 

           return (
            <DraggableWindow 
              key={id} id={id} 
              title={`NODE ${id} INTERNALS`} 
              icon={Search} 
              initialX={400 + (openWindows.indexOf(id) * 30)} 
              initialY={100 + (openWindows.indexOf(id) * 30)} 
              onClose={closeNodeWindow}
              onFocus={focusWindow}
              zIndex={zIndex}
            >
              <div style={{padding:'12px'}}>
                 <div style={styles.inspectorRow}>
                    <span style={{color:'#94a3b8'}}>ROLE</span>
                    <span style={{color:'white', fontWeight:'bold'}}>{node.role}</span>
                 </div>
                 <div style={styles.inspectorRow}>
                    <span style={{color:'#94a3b8'}}>BATTERY</span>
                    <span style={{color: node.battery > 30 ? '#4ade80' : '#f87171'}}>{node.battery}%</span>
                 </div>
                 <div style={styles.inspectorRow}>
                    <span style={{color:'#94a3b8'}}>NEXT HOP</span>
                    <span style={{color:'#38bdf8'}}>{node.nextHop ? `ID:${node.nextHop}` : 'NONE'}</span>
                 </div>
                 <div style={{marginTop:'10px', fontSize:'10px', color:'#38bdf8', fontWeight:'bold'}}>NEIGHBORS (LIVE)</div>
                 <div style={{backgroundColor:'rgba(0,0,0,0.2)', maxHeight:'120px', overflowY:'auto'}}>
                    {nodes.filter(n => n.id !== node.id).map(n => {
                          const dx = n.x - node.x; const dy = n.y - node.y;
                          const dist = Math.sqrt(dx*dx + dy*dy);
                          if (dist > config.uwbRange * PIXELS_PER_METER) return null;
                          const angle = Math.round(Math.atan2(dy, dx) * (180 / Math.PI));
                          return (
                            <div key={n.id} style={{...styles.inspectorRow, borderBottom:'1px dashed #334155'}}>
                               <span style={{color: getNodeColor(n)}}>ID:{n.id}</span>
                               <span>{(dist / PIXELS_PER_METER).toFixed(1)}m</span>
                               <span style={{color:'#cbd5e1'}}>{angle}°</span>
                            </div>
                          )
                    }).filter(Boolean)}
                 </div>
              </div>
            </DraggableWindow>
           );
        })}

        {/* LOGS WINDOW */}
        {showLogs && (
          <DraggableWindow id="logs" title="CLOUD DATABASE" icon={Database} initialX={500} initialY={500} onClose={() => setShowLogs(false)} onFocus={() => {}} zIndex={100}>
             <div style={{display:'flex', flexDirection:'column', gap:'4px', padding:'8px'}}>
                {logs.map((l, i) => (
                   <div key={i} style={{padding:'4px', borderBottom:'1px solid #1e293b', fontFamily:'monospace', fontSize:'10px',
                        color: l.type === 'SUCCESS' ? '#4ade80' : (l.type === 'WARN' ? '#fbbf24' : (l.type === 'ERROR' ? '#f87171' : '#94a3b8'))}}>
                      <span style={{opacity:0.5}}>[{l.time}]</span> {l.msg}
                   </div>
                ))}
                {logs.length === 0 && <div style={{textAlign:'center', color:'#475569', padding:'20px'}}>Waiting for reports...</div>}
             </div>
          </DraggableWindow>
        )}

        <svg width="100%" height="100%" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} 
             onContextMenu={(e) => e.preventDefault()} ref={svgRef}>
           <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />

          {config.showRange && nodes.map(n => (
            <circle key={`r-${n.id}`} cx={n.x} cy={n.y} r={config.uwbRange * PIXELS_PER_METER} 
              fill="none" stroke="#334155" strokeDasharray="4 4" opacity="0.3" pointerEvents="none" />
          ))}

          {links.map((l, i) => {
            const isElectedLink = l.source.role === 'LEADER' || l.target.role === 'LEADER';
            const color = isElectedLink ? '#ec4899' : '#22c55e';
            const midX = (l.source.x + l.target.x) / 2;
            const midY = (l.source.y + l.target.y) / 2;
            return (
              <g key={i} pointerEvents="none">
                <line x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} stroke={color} strokeOpacity="0.3" strokeWidth="1" />
                <rect x={midX - 14} y={midY - 7} width="28" height="14" rx="4" fill="#020617" opacity="0.8" />
                <text x={midX} y={midY + 3} textAnchor="middle" fill={color} fontSize="9" fontFamily="monospace" opacity="0.8">{(l.dist / PIXELS_PER_METER).toFixed(1)}m</text>
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
              <g key={n.id} transform={`translate(${n.x},${n.y})`} 
                 onMouseDown={(e) => handleMouseDown(e, n.id)}
                 onClick={() => { if(!n.isDragging) toggleMove(n.id) }} 
                 onContextMenu={(e) => { e.preventDefault(); openNodeWindow(n.id); }}
                 style={{cursor: 'grab'}}>
                
                {/* If open, show ring */}
                {openWindows.includes(n.id) && (
                   <circle r="22" fill="none" stroke="white" strokeWidth="1" strokeDasharray="2 2" opacity="0.8">
                      <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="3s" repeatCount="indefinite" />
                   </circle>
                )}

                {n.role === 'ISOLATED' && n.isolationTimer > config.isolationTimeout && (
                   <circle r="30" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.5">
                     <animate attributeName="r" from="20" to="50" dur="1s" repeatCount="indefinite" />
                     <animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite" />
                   </circle>
                )}

                <circle r="18" fill="#0f172a" stroke={color} strokeWidth="3" />
                <foreignObject x="-10" y="-10" width="20" height="20" style={{pointerEvents:'none'}}>
                   <div style={{display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color: color}}><Icon size={14} /></div>
                </foreignObject>

                <text y="32" textAnchor="middle" fill={color} fontSize="10" fontWeight="bold" fontFamily="monospace" pointerEvents="none">
                  {n.type === 'HARDWARE_GW' ? 'HW_GW' : (n.role === 'LEADER' ? 'ELECTED' : `ID:${n.id}`)}
                </text>
                <text y="44" textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace" pointerEvents="none">
                  {n.isMoving ? 'MOVING' : 'STATIC'}
                </text>
                <g transform="translate(12, -20)">
                   <rect x="0" y="0" width="14" height="8" rx="2" fill="#1e293b" stroke="#475569" />
                   <rect x="2" y="2" width={Math.max(0, (n.battery/100)*10)} height="4" rx="1" fill={n.battery > 30 ? '#22c55e' : '#ef4444'} />
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