import React, { useState, useEffect, useRef } from 'react';
import { GripHorizontal, LucideIcon } from 'lucide-react';

interface DraggableWindowProps {
  id: string | number;
  title: string;
  icon: LucideIcon;
  initialX: number;
  initialY: number;
  onClose: (id: string | number) => void;
  onFocus: (id: string | number) => void;
  zIndex: number;
  children: React.ReactNode;
}

export const DraggableWindow: React.FC<DraggableWindowProps> = ({ 
  id, title, icon: Icon, children, initialX, initialY, onClose, onFocus, zIndex 
}) => {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFocus(id);
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
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
      <div style={{maxHeight: '300px', overflowY: 'auto', padding: '0'}}>
        {children}
      </div>
    </div>
  );
};