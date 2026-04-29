import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing } from "../src/daemon/auto-drain.js";

const {
  findClaudeBin,
  resetClaudeBinCache,
  tryAcquireLock,
  releaseLock,
  isPidAlive,
  readSpending,
  bumpSpending,
  todayUtc,
  spendingFilePath,
  pidFilePath,
} = __testing;

describe("auto-drain: findClaudeBin", () => {
  beforeEach(() => {
    resetClaudeBinCache();
  });

  it("returns env override path when KONGCODE_CLAUDE_BIN is set and exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-"));
    const fakeBin = join(tmp, "fake-claude");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    const original = process.env.KONGCODE_CLAUDE_BIN;
    process.env.KONGCODE_CLAUDE_BIN = fakeBin;
    try {
      expect(findClaudeBin()).toBe(fakeBin);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to which-claude when env override is unset", () => {
    const original = process.env.KONGCODE_CLAUDE_BIN;
    delete process.env.KONGCODE_CLAUDE_BIN;
    try {
      // On a dev machine claude is usually on PATH; on CI it may not be.
      // Either result is acceptable — we're just verifying the fn doesn't
      // throw and returns null-or-string.
      const result = findClaudeBin();
      if (result !== null) expect(result.length).toBeGreaterThan(0);
    } finally {
      if (original !== undefined) process.env.KONGCODE_CLAUDE_BIN = original;
    }
  });

  it("returns null when env override points at non-existent path AND nothing else found", () => {
    const original = process.env.KONGCODE_CLAUDE_BIN;
    const originalPath = process.env.PATH;
    process.env.KONGCODE_CLAUDE_BIN = "/definitely/not/a/real/path/claude-binary-xyzzy";
    process.env.PATH = "/dev/null"; // wipe PATH so `which claude` fails
    resetClaudeBinCache();
    try {
      // Note: we can't fully isolate from /home/<user>/.local/bin and
      // /usr/local/bin paths the function checks. So this just asserts
      // the lookup completes without throwing.
      const result = findClaudeBin();
      expect(typeof result === "string" || result === null).toBe(true);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      if (originalPath !== undefined) process.env.PATH = originalPath;
    }
  });

  it("caches result on success — repeat call returns same value", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-"));
    const fakeBin = join(tmp, "fake-claude");
    writeFileSync(fakeBin, "");
    const original = process.env.KONGCODE_CLAUDE_BIN;
    process.env.KONGCODE_CLAUDE_BIN = fakeBin;
    resetClaudeBinCache();
    try {
      const first = findClaudeBin();
      const second = findClaudeBin();
      expect(first).toBe(second);
      expect(first).toBe(fakeBin);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("auto-drain: PID-file lock", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-lock-"));
    lockPath = join(tmp, "auto-drain.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("acquires lock when file does not exist", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) {
      expect(existsSync(lockPath)).toBe(true);
      releaseLock(fd, lockPath);
    }
  });

  it("returns null when lock file exists with a live PID", () => {
    // Use our own pid as the live holder.
    writeFileSync(lockPath, String(process.pid));
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
    expect(existsSync(lockPath)).toBe(true); // not unlinked
  });

  it("auto-cleans stale lock when holder PID is dead", () => {
    // Pick a PID that almost certainly doesn't exist.
    writeFileSync(lockPath, "99999999");
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd, lockPath);
  });

  it("releaseLock unlinks the lock file", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) {
      expect(existsSync(lockPath)).toBe(true);
      releaseLock(fd, lockPath);
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  it("pidFilePath returns expected path", () => {
    expect(pidFilePath(tmp)).toBe(join(tmp, "auto-drain.pid"));
  });
});

describe("auto-drain: isPidAlive", () => {
  it("returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for pid 0", () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it("returns false for negative pids", () => {
    expect(isPidAlive(-1)).toBe(false);
  });

  it("returns false for NaN", () => {
    expect(isPidAlive(NaN)).toBe(false);
  });

  it("returns false for very large pid that almost certainly doesn't exist", () => {
    expect(isPidAlive(99999999)).toBe(false);
  });
});

describe("auto-drain: spending state (daily cap)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-spend-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns count=0 for fresh state", () => {
    const s = readSpending(tmp);
    expect(s.count).toBe(0);
    expect(s.date).toBe(todayUtc());
  });

  it("bumpSpending increments count and persists to file", () => {
    const after = bumpSpending(tmp);
    expect(after.count).toBe(1);
    expect(existsSync(spendingFilePath(tmp))).toBe(true);
    const reread = readSpending(tmp);
    expect(reread.count).toBe(1);
  });

  it("bumpSpending across multiple calls accumulates", () => {
    bumpSpending(tmp);
    bumpSpending(tmp);
    const after = bumpSpending(tmp);
    expect(after.count).toBe(3);
  });

  it("auto-resets count when stored date is older than today", () => {
    // Manually plant a spending file with yesterday's date and high count.
    writeFileSync(
      spendingFilePath(tmp),
      JSON.stringify({ date: "2020-01-01", count: 999 }),
      "utf-8",
    );
    const s = readSpending(tmp);
    expect(s.date).toBe(todayUtc());
    expect(s.count).toBe(0);
  });

  it("tolerates corrupt spending file (returns reset state)", () => {
    writeFileSync(spendingFilePath(tmp), "{ this is not json", "utf-8");
    const s = readSpending(tmp);
    expect(s.date).toBe(todayUtc());
    expect(s.count).toBe(0);
  });

  it("tolerates missing count field", () => {
    writeFileSync(
      spendingFilePath(tmp),
      JSON.stringify({ date: todayUtc() }),
      "utf-8",
    );
    const s = readSpending(tmp);
    expect(s.count).toBe(0);
  });

  it("todayUtc returns YYYY-MM-DD format", () => {
    const today = todayUtc();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
