import React, { useState, useEffect, useRef } from "react";
import { GripHorizontal, LucideIcon } from "lucide-react";

interface DraggableWindowProps {
	id: string | number;
	title: string;
	icon: LucideIcon;
	initialX: number;
	initialY: number;
	initialWidth?: number;
	initialHeight?: number;
	resizable?: boolean;
	onClose: (id: string | number) => void;
	onFocus: (id: string | number) => void;
	zIndex: number;
	children: React.ReactNode;
}

export const DraggableWindow: React.FC<DraggableWindowProps> = ({
	id,
	title,
	icon: Icon,
	children,
	initialX,
	initialY,
	initialWidth = 300,
	initialHeight,
	resizable = false,
	onClose,
	onFocus,
	zIndex,
}) => {
	const [pos, setPos] = useState({ x: initialX, y: initialY });
	const [size, setSize] = useState({ width: initialWidth, height: initialHeight || "auto" });
	const [isDragging, setIsDragging] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const dragOffset = useRef({ x: 0, y: 0 });
	const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

	const handleMouseDown = (e: React.MouseEvent) => {
		e.stopPropagation();
		onFocus(id);
		setIsDragging(true);
		dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
	};

	const handleResizeMouseDown = (e: React.MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		onFocus(id);
		setIsResizing(true);
		const currentHeight =
			typeof size.height === "number" ? size.height : e.currentTarget.parentElement?.clientHeight || 300;
		resizeStart.current = { x: e.clientX, y: e.clientY, w: size.width, h: currentHeight };
	};

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (isDragging) {
				setPos({
					x: e.clientX - dragOffset.current.x,
					y: e.clientY - dragOffset.current.y,
				});
			}
			if (isResizing) {
				const deltaX = e.clientX - resizeStart.current.x;
				const deltaY = e.clientY - resizeStart.current.y;
				setSize({
					width: Math.max(200, resizeStart.current.w + deltaX),
					height: Math.max(150, resizeStart.current.h + deltaY),
				});
			}
		};
		const handleMouseUp = () => {
			setIsDragging(false);
			setIsResizing(false);
		};

		if (isDragging || isResizing) {
			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
		}
		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging, isResizing]);

	return (
		<div
			onMouseDown={() => onFocus(id)}
			style={{
				position: "absolute",
				left: pos.x,
				top: pos.y,
				width: size.width,
				height: size.height === "auto" ? "auto" : size.height,
				backgroundColor: "rgba(15, 23, 42, 0.95)",
				backdropFilter: "blur(10px)",
				border: "1px solid #38bdf8",
				borderRadius: "8px",
				boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
				zIndex: zIndex,
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div
				onMouseDown={handleMouseDown}
				style={{
					backgroundColor: "rgba(56, 189, 248, 0.15)",
					padding: "10px",
					borderBottom: "1px solid #334155",
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					cursor: "grab",
					userSelect: "none",
					flexShrink: 0,
				}}
			>
				<span
					style={{
						color: "#38bdf8",
						fontSize: "11px",
						fontWeight: "bold",
						display: "flex",
						alignItems: "center",
						gap: "8px",
					}}
				>
					<Icon size={12} /> {title}
				</span>
				<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
					<GripHorizontal size={12} color="#64748b" />
					<button
						onClick={(e) => {
							e.stopPropagation();
							onClose(id);
						}}
						style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontWeight: "bold" }}
					>
						✕
					</button>
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto", padding: "0", position: "relative" }}>{children}</div>
			{resizable && (
				<div
					onMouseDown={handleResizeMouseDown}
					style={{
						position: "absolute",
						bottom: 0,
						right: 0,
						width: "15px",
						height: "15px",
						cursor: "nwse-resize",
						background: "linear-gradient(135deg, transparent 50%, #38bdf8 50%)",
						opacity: 0.5,
					}}
				/>
			)}
		</div>
	);
};
