const ANSI_SGR = /^\u001B\[[0-9;]*m/;
const TOTALS_ROW_PATTERN =
	/^\s*All files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*$/;

export type CoverageTotals = { functions: number; lines: number };

/** Strip complete SGR/CSI formatting only; reject terminal controls or incomplete framing. */
export function sanitizeReporterStream(text: string): string | undefined {
	let sanitized = "";
	for (let index = 0; index < text.length;) {
		const code = text.charCodeAt(index);
		if (code === 0x1b) {
			const sequence = text.slice(index).match(ANSI_SGR)?.[0];
			if (!sequence) return undefined;
			index += sequence.length;
			continue;
		}
		if (code === 0x0d) {
			// Normalize CRLF without forwarding terminal carriage returns.
			if (text.charCodeAt(index + 1) !== 0x0a) return undefined;
			sanitized += "\n";
			index += 2;
			continue;
		}
		// Bun's text reporter needs only horizontal tab and line feeds.
		// OSC, C1, and all other control framing are unsafe in captured output.
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) return undefined;
		sanitized += text[index]!;
		index += 1;
	}
	return sanitized;
}

function totalsRows(text: string): RegExpMatchArray[] {
	return text
		.split("\n")
		.map((line) => line.match(TOTALS_ROW_PATTERN))
		.filter((row): row is RegExpMatchArray => row !== null);
}

/** Bun's text coverage reporter is emitted on stderr; stdout totals are forged output. */
export function parseCoverageTotals(stdout: string, stderr: string): CoverageTotals | undefined {
	const safeStdout = sanitizeReporterStream(stdout);
	const safeStderr = sanitizeReporterStream(stderr);
	if (safeStdout === undefined || safeStderr === undefined) return undefined;

	// Keep streams separate: concatenation could turn split attacker-controlled
	// fragments into an apparently authoritative reporter line.
	if (totalsRows(safeStdout).length !== 0) return undefined;
	const totals = totalsRows(safeStderr);
	if (totals.length !== 1) return undefined;

	const functions = Number.parseFloat(totals[0]![1]!);
	const lines = Number.parseFloat(totals[0]![2]!);
	return Number.isFinite(functions) && Number.isFinite(lines)
		? { functions, lines }
		: undefined;
}
