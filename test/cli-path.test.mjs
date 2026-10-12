import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCli } from "../src/cli-path.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tesla-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (folder, mode = 0o755) => {
    const bin = path.join(root, folder, "tool");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nprintf resolved", { mode });
    return bin;
  };
}

test("explicit configuration wins even when PATH contains another installation", (t) => {
  const bin = fixture(t)("on-path");
  assert.equal(resolveCli("tool", { override: "/chosen/tool", searchPath: path.dirname(bin), fallbacks: [bin] }), "/chosen/tool");
});

test("PATH order wins over architecture fallbacks and supports spaces", (t) => {
  const make = fixture(t), first = make("custom bin"), second = make("homebrew");
  const found = resolveCli("tool", { searchPath: [path.dirname(first), path.dirname(second)].join(path.delimiter), fallbacks: [second] });
  assert.equal(found, first);
  assert.equal(execFileSync(found, [], { encoding: "utf8" }), "resolved");
});

test("minimal launchd PATH uses an available Apple Silicon or Intel fallback", (t) => {
  const make = fixture(t), arm = make("opt/homebrew/bin"), intel = make("usr/local/bin");
  const options = { searchPath: "/nonexistent", fallbacks: [arm, intel] };
  assert.equal(resolveCli("tool", options), arm);
  fs.unlinkSync(arm);
  assert.equal(resolveCli("tool", options), intel);
});

test("unexecutable files and directories do not mask a working fallback", (t) => {
  const make = fixture(t), bad = make("bad", 0o644), good = make("good");
  assert.equal(resolveCli("tool", { searchPath: path.dirname(bad), fallbacks: [path.dirname(good), good] }), good);
});

test("missing executable remains a command name instead of a false absolute path", () => {
  assert.equal(resolveCli("not-installed", { searchPath: "", fallbacks: ["/nonexistent/tool"] }), "not-installed");
});

test("Node defaults to the running executable and explicit overrides are preserved", () => {
  const url = new URL("../src/config.mjs", import.meta.url).href;
  const script = `import { config } from ${JSON.stringify(url)}; process.stdout.write(config.nodeCli);`;
  const env = { ...process.env, PATH: "", NODE_CLI: "" };
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }), process.execPath);
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, NODE_CLI: "/custom/node" }, encoding: "utf8" }), "/custom/node");
});
