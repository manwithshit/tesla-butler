import { execFile, spawn } from "node:child_process";

export function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout || 60_000,
      signal: options.signal,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function spawnStreaming(file, args, options = {}) {
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}
