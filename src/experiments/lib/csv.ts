import { writeFileSync } from "fs";

/**
 * Writes a CSV file (header + newline-separated rows).
 *
 * We keep this tiny on purpose so the experiment logic stays readable.
 */
export function writeCsv(filename: string, header: string, lines: string[]) {
	writeFileSync(filename, header + lines.join("\n"));
	console.log(`${filename} written`);
}
