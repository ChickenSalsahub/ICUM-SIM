export type RngFn = () => number;

// Deterministic, fast PRNG with decent statistical properties for simulation.
// Returns a function compatible with Math.random() (uniform in [0, 1)).
//
// Mulberry32: https://github.com/bryc/code/blob/master/jshash/PRNGs.md
export function createMulberry32(seed: number): RngFn {
	let a = (seed | 0) >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
