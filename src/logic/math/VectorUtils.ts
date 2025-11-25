export interface Vector2D {
	x: number;
	y: number;
}

export interface Pose2D extends Vector2D {
	theta: number; // radians
}

export class VectorUtils {
	static add(v1: Vector2D, v2: Vector2D): Vector2D {
		return { x: v1.x + v2.x, y: v1.y + v2.y };
	}

	static sub(v1: Vector2D, v2: Vector2D): Vector2D {
		return { x: v1.x - v2.x, y: v1.y - v2.y };
	}

	static scale(v: Vector2D, s: number): Vector2D {
		return { x: v.x * s, y: v.y * s };
	}

	static mag(v: Vector2D): number {
		return Math.sqrt(v.x * v.x + v.y * v.y);
	}

	static dist(v1: Vector2D, v2: Vector2D): number {
		return this.mag(this.sub(v1, v2));
	}

	static normalize(v: Vector2D): Vector2D {
		const m = this.mag(v);
		if (m === 0) return { x: 0, y: 0 };
		return { x: v.x / m, y: v.y / m };
	}

	static rotate(v: Vector2D, angleRad: number): Vector2D {
		const c = Math.cos(angleRad);
		const s = Math.sin(angleRad);
		return {
			x: v.x * c - v.y * s,
			y: v.x * s + v.y * c,
		};
	}

	static dot(v1: Vector2D, v2: Vector2D): number {
		return v1.x * v2.x + v1.y * v2.y;
	}
}
