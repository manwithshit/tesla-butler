import fs from "node:fs";
import path from "node:path";

// No shell lookup: paths containing spaces stay a single executable argument.
export function resolveCli(command, { override, searchPath = process.env.PATH || "", fallbacks = [] } = {}) {
  if (override) return override;
  const candidates = [
    ...searchPath.split(path.delimiter).filter((entry) => path.isAbsolute(entry)).map((entry) => path.join(entry, command)),
    ...fallbacks
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Missing or non-executable candidates are normal on other installations.
    }
  }
  return command;
}
