/**
 * The monthly CPI (TÜFE) series that ships with Vigil (#47). The file format and the factor between two period ends
 * are in `@vigil/core` (`cpi.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CpiSeries, parseCpiCsv } from "@vigil/core";

/** The CPI series that ships with Vigil: TÜİK's general index, refreshed monthly by maintainers (`bun run cpi:import`). */
export const CPI_FILE = fileURLToPath(new URL("../reference/cpi-tr.csv", import.meta.url));

/** Read and check a CPI series file; any problem raises an error naming the line. */
export function readCpiFile(path: string): CpiSeries {
  return parseCpiCsv(readFileSync(path, "utf8"));
}
