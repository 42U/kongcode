import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleSockets } from "../src/http-api.js";

describe("sweepStaleSockets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kongcode-sweep-"));
  });

  afterEach(() => {
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
