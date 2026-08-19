import { describe, expect, test } from "bun:test";
import {
  parseCoverageTotals,
  sanitizeReporterStream,
} from "../scripts/coverage-parser.js";

const CANONICAL_TOTALS = "All files | 88.50 | 91.25 |\n";

describe("coverage reporter stream sanitization", () => {
  test("removes complete SGR sequences and normalizes CRLF", () => {
    const sgr = String.fromCharCode(0x1b);
    expect(
      sanitizeReporterStream(
        `${sgr}[1mAll files${sgr}[0m | 88.50 | 91.25 |\r\n`,
      ),
    ).toBe(CANONICAL_TOTALS);
  });

  test("rejects terminal control framing other than complete SGR and CRLF", () => {
    const esc = String.fromCharCode(0x1b);
    const cases = [
      ["an OSC sequence", `${esc}]0;forged title${String.fromCharCode(0x07)}`],
      ["an unmatched CSI sequence", `${esc}[31`],
      ["a bare carriage return", "All files | 88.50 | 91.25 |\r"],
      ["an unsafe C0 control", `prefix${String.fromCharCode(0x0b)}suffix`],
      ["an unsafe C1 control", `prefix${String.fromCharCode(0x9b)}suffix`],
    ] as const;

    for (const [description, input] of cases) {
      expect(sanitizeReporterStream(input), description).toBeUndefined();
    }
  });
});

describe("coverage totals parser", () => {
  test("accepts exactly one canonical stderr totals row", () => {
    expect(parseCoverageTotals("reporter progress\n", CANONICAL_TOTALS)).toEqual({
      functions: 88.5,
      lines: 91.25,
    });
  });

  test("rejects unauthoritative, ambiguous, and invalid totals", () => {
    const cases = [
      ["a totals row on stdout", CANONICAL_TOTALS, "reporter progress\n"],
      ["duplicate stderr totals rows", "", CANONICAL_TOTALS.repeat(2)],
      [
        "a row split between stdout and stderr",
        "All files | 88.50 |",
        " 91.25 |\n",
      ],
      [
        "a control-framed row split between stdout and stderr",
        `All files | 88.50 |${String.fromCharCode(0x1b)}[31m`,
        " 91.25 |\n",
      ],
      ["a malformed totals row", "", "All files | 88.50 | ninety-one |\n"],
      ["a missing totals row", "", "reporter progress\n"],
      ["a nonfinite functions total", "", "All files | Infinity | 91.25 |\n"],
      ["a nonfinite lines total", "", "All files | 88.50 | NaN |\n"],
    ] as const;

    for (const [description, stdout, stderr] of cases) {
      expect(parseCoverageTotals(stdout, stderr), description).toBeUndefined();
    }
  });
});
