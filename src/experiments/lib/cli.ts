/**
 * Tiny CLI helpers for experiments.
 *
 * Pattern matches the seed helper (`getCliSeed`) but for numeric flags.
 */
export function getCliNumber(flagName: string, defaultValue: number): number {
	const argv = process.argv.slice(2);
	const long = `--${flagName}`;
	const eq = argv.find((a) => a.startsWith(`${long}=`));
	if (eq) {
		const v = Number(eq.split("=")[1]);
		return Number.isFinite(v) ? v : defaultValue;
	}
	const idx = argv.indexOf(long);
	if (idx >= 0 && idx + 1 < argv.length) {
		const v = Number(argv[idx + 1]);
		return Number.isFinite(v) ? v : defaultValue;
	}
	return defaultValue;
}
