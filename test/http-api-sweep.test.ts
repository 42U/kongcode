import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { sweepStaleSockets } from "../src/http-api.js";

// All existing assertions in this suite rely on alive-sibling sockets being
// PRESERVED. The reaper added in 0.4.3 would SIGTERM the test runner (which
// is process.ppid here) and kill the suite mid-run. Force keep-siblings
// semantics for those tests; the reaper has its own dedicated suite below
// where a controlled child process is the SIGTERM target.
const ORIGINAL_KEEP = process.env.KONGCODE_KEEP_SIBLINGS;

describe("sweepStaleSockets — keep-siblings semantics (KONGCODE_KEEP_SIBLINGS=1)", () => {
  let dir: string;

  beforeEach(() => {
    process.env.KONGCODE_KEEP_SIBLINGS = "1";
    dir = mkdtempSync(join(tmpdir(), "kongcode-sweep-"));
  });

  afterEach(() => {
    if (ORIGINAL_KEEP === undefined) delete process.env.KONGCODE_KEEP_SIBLINGS;
    else process.env.KONGCODE_KEEP_SIBLINGS = ORIGINAL_KEEP;
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(name: string) {
    writeFileSync(join(dir, name), "");
  }

  it("removes socket files whose PID is dead (ESRCH)", () => {
    // PID 99999999 is well above the typical pid_max and effectively guaranteed dead.
    touch(".kongcode-99999999.sock");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".kongcode-99999999.sock"))).toBe(false);
  });

  it("preserves the own-pid socket", () => {
    touch(`.kongcode-${process.pid}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.kongcode-${process.pid}.sock`))).toBe(true);
  });

  it("preserves a socket whose PID is currently alive", () => {
    // Use the parent pid — guaranteed alive while this test runs.
    const aliveParent = process.ppid;
    touch(`.kongcode-${aliveParent}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.kongcode-${aliveParent}.sock`))).toBe(true);
  });

  it("ignores files that don't match the .kongcode-<pid>.sock pattern", () => {
    touch(".kongcode.sock"); // legacy single-socket name — no pid
    touch(".kongcode-port"); // port file
    touch("random.txt");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".kongcode.sock"))).toBe(true);
    expect(existsSync(join(dir, ".kongcode-port"))).toBe(true);
    expect(existsSync(join(dir, "random.txt"))).toBe(true);
  });

  it("mixed case: sweeps dead, keeps alive + own + non-matching in one pass", () => {
    touch(".kongcode-99999999.sock"); // dead
    touch(".kongcode-99999998.sock"); // dead
    touch(`.kongcode-${process.pid}.sock`); // own
    touch(`.kongcode-${process.ppid}.sock`); // alive
    touch(".kongcode.sock"); // legacy

    sweepStaleSockets(dir, process.pid);

    expect(existsSync(join(dir, ".kongcode-99999999.sock"))).toBe(false);
    expect(existsSync(join(dir, ".kongcode-99999998.sock"))).toBe(false);
    expect(existsSync(join(dir, `.kongcode-${process.pid}.sock`))).toBe(true);
    expect(existsSync(join(dir, `.kongcode-${process.ppid}.sock`))).toBe(true);
    expect(existsSync(join(dir, ".kongcode.sock"))).toBe(true);
  });

  it("is a no-op on a non-existent directory", () => {
    expect(() => sweepStaleSockets(join(dir, "does-not-exist"), process.pid)).not.toThrow();
  });
});

describe("sweepStaleSockets — reaper (default-on)", () => {
  let dir: string;
  let child: ChildProcess | null = null;

  function touch(name: string) {
    writeFileSync(join(dir, name), "");
  }

  function spawnSleeper(): Promise<ChildProcess> {
    // Long-sleeping bash is a safe SIGTERM target — no I/O, no cleanup,
    // exits cleanly when terminated.
    return new Promise((resolve, reject) => {
      const c = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: false });
      c.on("error", reject);
      c.on("spawn", () => resolve(c));
    });
  }

  function waitForExit(p: ChildProcess, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      if (p.exitCode != null || p.signalCode != null) return resolve(true);
      const t = setTimeout(() => resolve(false), timeoutMs);
      p.once("exit", () => { clearTimeout(t); resolve(true); });
    });
  }

  beforeEach(() => {
    delete process.env.KONGCODE_KEEP_SIBLINGS; // ensure default-on
    dir = mkdtempSync(join(tmpdir(), "kongcode-reap-"));
  });

  afterEach(() => {
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    child = null;
    if (ORIGINAL_KEEP !== undefined) process.env.KONGCODE_KEEP_SIBLINGS = ORIGINAL_KEEP;
    rmSync(dir, { recursive: true, force: true });
  });

  it("SIGTERMs an alive sibling MCP and removes its socket file", async () => {
    child = await spawnSleeper();
    const siblingPid = child.pid!;
    touch(`.kongcode-${siblingPid}.sock`);

    sweepStaleSockets(dir, process.pid);

    const exited = await waitForExit(child);
    expect(exited).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    expect(existsSync(join(dir, `.kongcode-${siblingPid}.sock`))).toBe(false);
  });

  it("opt-out via KONGCODE_KEEP_SIBLINGS=1 leaves the sibling alive", async () => {
    process.env.KONGCODE_KEEP_SIBLINGS = "1";
    child = await spawnSleeper();
    const siblingPid = child.pid!;
    touch(`.kongcode-${siblingPid}.sock`);

    sweepStaleSockets(dir, process.pid);

    // Sibling should still be alive (not SIGTERMed)
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(existsSync(join(dir, `.kongcode-${siblingPid}.sock`))).toBe(true);
    delete process.env.KONGCODE_KEEP_SIBLINGS;
  });

  it("never reaps the own-pid socket even when default-on", () => {
    touch(`.kongcode-${process.pid}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.kongcode-${process.pid}.sock`))).toBe(true);
  });

  it("still removes truly-dead PID socket files (ESRCH path unchanged)", () => {
    touch(".kongcode-99999999.sock");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".kongcode-99999999.sock"))).toBe(false);
  });
});
