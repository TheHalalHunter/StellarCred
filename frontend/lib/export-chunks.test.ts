// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import path from "path";
import {
  auditLogBootstrap,
  auditLogClear,
  auditLogEntries,
  auditLogSize,
  auditLogVerify,
} from "./audit-log";
import { serveExportChunk } from "./export-chunks";
import {
  createExportJob,
  getCursorHandle,
  __resetExportJobStoreForTesting,
  type ExportRow,
} from "./export-job-store";
import {
  createExportRecord,
  revokeExportRecord,
  __resetExportStoreForTesting,
} from "./export-store";
import { verifyCursor } from "./export-cursor";
import {
  MemoryStore,
  setSharedStoreForTesting,
  type KeyValueStore,
} from "./shared-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRows(n: number): ExportRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: "rec-1",
    field: `f${i}`,
    value: `v${i}`,
  }));
}

const ORIGINAL_CURSOR_SECRET = process.env.EXPORT_CURSOR_SECRET;
const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;
const ORIGINAL_AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH;

function freshAuditPath(): string {
  return path.join(
    tmpdir(),
    `audit-784-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

/**
 * FlakyStore wraps an inner store and simulates transient shared-store
 * failures: rejects `set` for keys matching a predicate, and rejects `get` for
 * a specific key on the first `times` calls. All other ops delegate. Pre-seeded
 * data lives in the inner store, captured via getSharedStore() before swapping.
 */
class FlakyStore implements KeyValueStore {
  readonly name = "flaky";
  private inner: KeyValueStore;
  private rejectSetFor: ((key: string) => boolean) | null;
  private rejectGetKey: string | null;
  private rejectGetTimes: number;
  private getRejectCount = 0;

  constructor(
    inner: KeyValueStore,
    opts: {
      rejectSetFor?: (key: string) => boolean;
      rejectGetKey?: string;
      rejectGetTimes?: number;
    } = {},
  ) {
    this.inner = inner;
    this.rejectSetFor = opts.rejectSetFor ?? null;
    this.rejectGetKey = opts.rejectGetKey ?? null;
    this.rejectGetTimes = opts.rejectGetTimes ?? 0;
  }

  async get(key: string): Promise<string | null> {
    if (
      this.rejectGetKey !== null &&
      key === this.rejectGetKey &&
      this.getRejectCount < this.rejectGetTimes
    ) {
      this.getRejectCount++;
      throw new Error(`simulated transient get failure for ${key}`);
    }
    return this.inner.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.rejectSetFor?.(key)) {
      throw new Error(`simulated set failure for ${key}`);
    }
    return this.inner.set(key, value, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    return this.inner.del(key);
  }

  async incr(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ count: number; ttlRemainingMs: number }> {
    return this.inner.incr(key, ttlSeconds);
  }

  async clear(): Promise<void> {
    return this.inner.clear?.();
  }
}

async function setupMultiChunkJob(
  rows = 250,
  chunkSize = 100,
): Promise<{ record: { id: string }; job: { jobId: string; totalChunks: number } }> {
  const record = await createExportRecord({
    issuer: "GISS",
    commitment: "0xabc",
    credentialType: "kyc",
    requestedAt: new Date().toISOString(),
    artifactUrl: null,
    metadata: {},
  });
  const job = await createExportJob({
    recordId: record.id,
    rows: makeRows(rows),
    chunkSize,
  });
  return { record, job };
}

describe("export-chunks — serveExportChunk", () => {
  let innerStore: KeyValueStore;

  beforeEach(async () => {
    innerStore = new MemoryStore();
    setSharedStoreForTesting(innerStore);
    __resetExportJobStoreForTesting();
    __resetExportStoreForTesting();
    process.env.ADMIN_API_KEY = "test-admin-key";
    delete process.env.EXPORT_CURSOR_SECRET;
    // Isolate the audit sink to a temp file so auditLogPersist never touches
    // the repo .data/audit-log.jsonl.
    const auditPath = freshAuditPath();
    process.env.AUDIT_LOG_PATH = auditPath;
    auditLogClear();
    await auditLogBootstrap(auditPath);
    auditLogClear(); // ensure in-memory chain is empty after bootstrapping the sink
  });

  afterEach(() => {
    setSharedStoreForTesting(null);
    if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = ORIGINAL_ADMIN_KEY;
    if (ORIGINAL_CURSOR_SECRET === undefined) delete process.env.EXPORT_CURSOR_SECRET;
    else process.env.EXPORT_CURSOR_SECRET = ORIGINAL_CURSOR_SECRET;
    if (ORIGINAL_AUDIT_LOG_PATH === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = ORIGINAL_AUDIT_LOG_PATH;
    auditLogClear();
  });

  it("pages through all chunks via nextCursor until done", async () => {
    const { record, job } = await setupMultiChunkJob(250, 100);
    expect(job.totalChunks).toBe(3);

    const collected: ExportRow[] = [];
    let cursor: string | null = null;
    let calls = 0;
    let lastIndex = -1;
    for (;;) {
      const res = await serveExportChunk({
        recordId: record.id,
        cursor,
        limit: null,
      });
      expect(res.status).toBe(200);
      if (res.status !== 200) break;
      const body = res.body as {
        index: number;
        totalChunks: number;
        chunk: { rows: ExportRow[] };
        nextCursor: string | null;
        done: boolean;
      };
      expect(body.index).toBe(lastIndex + 1);
      lastIndex = body.index;
      collected.push(...body.chunk.rows);
      cursor = body.nextCursor;
      calls++;
      if (body.done) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      if (calls > 10) throw new Error("did not terminate");
    }
    expect(calls).toBe(3);
    expect(collected).toHaveLength(250);
    expect(collected.map((r) => r.field)).toEqual(
      makeRows(250).map((r) => r.field),
    );
  });

  it("partial download: no-cursor returns chunk 0 + nextCursor (done false when >1 chunk)", async () => {
    const { record } = await setupMultiChunkJob(250, 100);
    const res = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    expect(res.status).toBe(200);
    const body = res.body as { index: number; done: boolean; nextCursor: string | null };
    expect(body.index).toBe(0);
    expect(body.done).toBe(false);
    expect(typeof body.nextCursor).toBe("string");
    expect(body.nextCursor).not.toBeNull();
  });

  it("resumed download across restart: reset in-memory state, continue with saved cursor", async () => {
    const { record, job } = await setupMultiChunkJob(250, 100);

    // Fetch chunk 0, keep the cursor.
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const firstBody = first.body as { nextCursor: string | null };
    const savedCursor = firstBody.nextCursor!;
    expect(savedCursor).toBeTruthy();

    // Simulate a worker restart: clear module caches; shared store survives.
    __resetExportStoreForTesting();
    __resetExportJobStoreForTesting();

    // Continue paging with the saved cursor; remaining chunks must arrive in order.
    const collected: ExportRow[] = [];
    let cursor: string | null = savedCursor;
    let calls = 0;
    for (;;) {
      const res = await serveExportChunk({
        recordId: record.id,
        cursor,
        limit: null,
      });
      expect(res.status).toBe(200);
      if (res.status !== 200) break;
      const body = res.body as {
        index: number;
        chunk: { rows: ExportRow[] };
        nextCursor: string | null;
        done: boolean;
      };
      collected.push(...body.chunk.rows);
      cursor = body.nextCursor;
      calls++;
      if (body.done) break;
      if (calls > 10) throw new Error("did not terminate");
    }
    expect(calls).toBe(2); // chunks 1 and 2
    expect(collected).toHaveLength(150);
    expect(collected.map((r) => r.field)).toEqual(
      makeRows(250).slice(100).map((r) => r.field),
    );
  });

  it("first-call restarts at 0 when no cursor (losing the cursor re-starts)", async () => {
    const { record } = await setupMultiChunkJob(250, 100);
    await serveExportChunk({ recordId: record.id, cursor: null, limit: null });
    __resetExportStoreForTesting();
    __resetExportJobStoreForTesting();
    const res = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    expect(res.status).toBe(200);
    expect((res.body as { index: number }).index).toBe(0);
  });

  it("rejects a tampered cursor with 400", async () => {
    const { record } = await setupMultiChunkJob(250, 100);
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const token = (first.body as { nextCursor: string }).nextCursor;
    const tampered = token.slice(0, -2) + "00";
    const res = await serveExportChunk({
      recordId: record.id,
      cursor: tampered,
      limit: null,
    });
    expect(res.status).toBe(400);
    expect((res.body as { reason: string }).reason).toBeTruthy();
  });

  it("rejects a cursor whose jobId is bound to a different record (400 mismatch)", async () => {
    const a = await setupMultiChunkJob(250, 100);
    const b = await setupMultiChunkJob(250, 100);
    const first = await serveExportChunk({
      recordId: a.record.id,
      cursor: null,
      limit: null,
    });
    const aCursor = (first.body as { nextCursor: string }).nextCursor;
    // Use record A's cursor against record B's path.
    const res = await serveExportChunk({
      recordId: b.record.id,
      cursor: aCursor,
      limit: null,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("does not match");
  });

  it("rejects an out-of-range cursor with 400", async () => {
    const { record, job } = await setupMultiChunkJob(10, 100); // 1 chunk
    // Craft a cursor for index 5 (out of range) signed with the real secret.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCursor } = await import("./export-cursor");
    const bad = createCursor(job.jobId, 5);
    const res = await serveExportChunk({
      recordId: record.id,
      cursor: bad,
      limit: null,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("out of range");
  });

  it("returns 404 for a cursor whose job is gone (valid sig but unknown job)", async () => {
    const { record, job } = await setupMultiChunkJob(10, 100);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCursor } = await import("./export-cursor");
    const cursor = createCursor(job.jobId, 0);
    // Wipe the job from the shared store + caches.
    setSharedStoreForTesting(new MemoryStore());
    __resetExportJobStoreForTesting();
    const res = await serveExportChunk({
      recordId: record.id,
      cursor,
      limit: null,
    });
    expect(res.status).toBe(404);
  });

  it("revoke still blocks chunk access (403 via record.revokedAt)", async () => {
    const { record } = await setupMultiChunkJob(250, 100);
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    await revokeExportRecord(record.id, "admin");

    // Cursor path → 403.
    const resCursor = await serveExportChunk({
      recordId: record.id,
      cursor,
      limit: null,
    });
    expect(resCursor.status).toBe(403);
    // No-cursor path → 403.
    const resNoCursor = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    expect(resNoCursor.status).toBe(403);
  });

  it("limit at creation controls chunk count (250 rows / limit 50 → 5 chunks)", async () => {
    const record = await createExportRecord({
      issuer: "GISS",
      commitment: "0xabc",
      credentialType: "kyc",
      requestedAt: new Date().toISOString(),
      artifactUrl: null,
      metadata: {},
    });
    // Inject 250 rows by pre-creating a job with limit 50.
    await createExportJob({
      recordId: record.id,
      rows: makeRows(250),
      chunkSize: 50,
    });
    const res = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: 50,
    });
    expect(res.status).toBe(200);
    expect((res.body as { totalChunks: number }).totalChunks).toBe(5);
  });

  it("audit: start appends export:chunk, done appends export:chunk:done, valid chain", async () => {
    const { record } = await setupMultiChunkJob(250, 100); // 3 chunks
    // Chunk 0 (start) — appends export:chunk.
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const firstCursor = (first.body as { nextCursor: string }).nextCursor;
    let entries = auditLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].adminAction).toBe("export:chunk");
    expect(entries[0].issuer).toBe("admin");
    expect(entries[0].commitment).toBe(record.id);
    expect(auditLogVerify().valid).toBe(true);

    // Chunk 1 (intermediate): no append, no persist.
    const sizeBeforeIntermediate = auditLogSize();
    const r1 = await serveExportChunk({
      recordId: record.id,
      cursor: firstCursor,
      limit: null,
    });
    expect(r1.status).toBe(200);
    expect(auditLogSize()).toBe(sizeBeforeIntermediate);
  });

  it("audit done entry: chunk:done appended on the final chunk with valid chain", async () => {
    const { record } = await setupMultiChunkJob(10, 100); // 1 chunk → start AND done
    await serveExportChunk({ recordId: record.id, cursor: null, limit: null });
    const entries = auditLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].adminAction).toBe("export:chunk");
    expect(entries[1].adminAction).toBe("export:chunk:done");
    expect(auditLogVerify().valid).toBe(true);
  });

  it("no-cursor reuse: a second no-cursor call returns the same jobId at index 0", async () => {
    const { record, job } = await setupMultiChunkJob(250, 100);
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const second = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: 50, // different limit — must be ignored (job exists)
    });
    expect((second.body as { jobId: string; index: number }).jobId).toBe(
      (first.body as { jobId: string }).jobId,
    );
    expect((second.body as { index: number }).index).toBe(0);
    expect((second.body as { jobId: string }).jobId).toBe(job.jobId);
  });

  it("cursor-progress write failure does not break a chunk serve (MEDIUM regression)", async () => {
    const { record, job } = await setupMultiChunkJob(250, 100); // 3 chunks
    // Serve chunk 0 to get a cursor for chunk 1.
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const cursor = (first.body as { nextCursor: string }).nextCursor;

    // Swap to a FlakyStore that rejects set for export:cursor:* (all else
    // delegates to the inner store holding the job/chunk data).
    const flaky = new FlakyStore(innerStore, {
      rejectSetFor: (k) => k.startsWith("export:cursor:"),
    });
    setSharedStoreForTesting(flaky);
    __resetExportJobStoreForTesting(); // forces reads to go through the store

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await serveExportChunk({
      recordId: record.id,
      cursor,
      limit: null,
    });
    expect(res.status).toBe(200);
    expect((res.body as { index: number }).index).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    // The handle write was dropped; the inner handle still reflects chunk 0.
    setSharedStoreForTesting(innerStore);
    const handle = await getCursorHandle(job.jobId);
    expect(handle?.lastIndex).toBe(0);
  });

  it("no-secret start path leaves no orphan audit entry (orphan NIT regression)", async () => {
    const { record } = await setupMultiChunkJob(250, 100); // 3 chunks, job already created
    // Unset BOTH secrets so createCursor throws.
    delete process.env.EXPORT_CURSOR_SECRET;
    delete process.env.ADMIN_API_KEY;
    const sizeBefore = auditLogSize();
    // serveExportChunk throws synchronously (createCursor throws); the route
    // would catch it as a 500. At the lib level we just verify it throws AND
    // that no audit entry was appended before the throw.
    await expect(
      serveExportChunk({ recordId: record.id, cursor: null, limit: null }),
    ).rejects.toThrow();
    expect(auditLogSize()).toBe(sizeBefore);
  });

  it("transient chunk-read 404 keeps the cursor valid for retry (transient-404 NIT regression)", async () => {
    const { record, job } = await setupMultiChunkJob(250, 100); // 3 chunks
    // Serve chunk 0 → cursor for chunk 1.
    const first = await serveExportChunk({
      recordId: record.id,
      cursor: null,
      limit: null,
    });
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    const chunk1Key = `export:job:${job.jobId}:chunk:1`;

    // FlakyStore: get rejects for the chunk-1 key ONCE, then delegates.
    const flaky = new FlakyStore(innerStore, {
      rejectGetKey: chunk1Key,
      rejectGetTimes: 1,
    });
    setSharedStoreForTesting(flaky);
    __resetExportJobStoreForTesting();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res1 = await serveExportChunk({
      recordId: record.id,
      cursor,
      limit: null,
    });
    expect(res1.status).toBe(404); // transient read blip swallowed as a miss
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    // The cursor is still valid (self-contained signed token).
    expect(verifyCursor(cursor).ok).toBe(true);

    // Same cursor retry → 200 with chunk 1 (get now delegates).
    const res2 = await serveExportChunk({
      recordId: record.id,
      cursor,
      limit: null,
    });
    expect(res2.status).toBe(200);
    expect((res2.body as { index: number }).index).toBe(1);
  });
});
