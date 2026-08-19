import { parseCoverageTotals, sanitizeReporterStream } from "./coverage-parser.js";

const MINIMUM_FUNCTION_COVERAGE = 85;
const MINIMUM_LINE_COVERAGE = 90;

function failMissingTotals(): never {
	console.error("Coverage gate could not read Bun coverage totals.");
	process.exit(1);
}

async function main() {
	const child = Bun.spawn({
		cmd: ["bun", "test", "--coverage", "--coverage-reporter=text"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	const safeStdout = sanitizeReporterStream(stdout);
	const safeStderr = sanitizeReporterStream(stderr);
	if (safeStdout === undefined || safeStderr === undefined) failMissingTotals();
	process.stdout.write(safeStdout);
	process.stderr.write(safeStderr);

	if (status !== 0) process.exit(status);

	const totals = parseCoverageTotals(safeStdout, safeStderr);
	if (!totals) failMissingTotals();

	if (
		totals.functions < MINIMUM_FUNCTION_COVERAGE ||
		totals.lines < MINIMUM_LINE_COVERAGE
	) {
		console.error(
			`Coverage gate failed: ${totals.functions.toFixed(2)}% functions (minimum ${MINIMUM_FUNCTION_COVERAGE}%), ${totals.lines.toFixed(2)}% lines (minimum ${MINIMUM_LINE_COVERAGE}%).`,
		);
		process.exit(1);
	}

	console.log(
		`Coverage gate passed: ${totals.functions.toFixed(2)}% functions (minimum ${MINIMUM_FUNCTION_COVERAGE}%), ${totals.lines.toFixed(2)}% lines (minimum ${MINIMUM_LINE_COVERAGE}%).`,
	);
}

if (import.meta.main) await main();
