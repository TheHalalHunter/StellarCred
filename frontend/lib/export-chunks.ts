/**
 * serveExportChunk — orchestrator for resumable chunked export downloads (#784).
 *
 * The route (`app/api/admin/exports/[id]/chunks/route.ts`) is a thin wrapper:
 * it enforces `checkAdminAuth`, calls `auditLogBootstrap`, parses params, and
 * serializes this function's result. All chunk/resume logic lives here so it is
 * independently unit-testable.
 *
 * Resumability: the resume cursor is the signed, self-contained token returned
 * as `nextCursor` — it survives a worker restart in the client's hands. The
 * persisted `CursorHandle` (in the shared store) is observability/progress-only.
 * A valid cursor after a restart resolves the job + chunk from the shared
 * store (memory caches miss → KV fallback), so the download continues without
 * recompute and without relying on in-memory state.
 */

import { auditLogAppend, auditLogPersist } from "./audit-log";
import {
  buildExportRows,
  createExportJob,
  DEFAULT_CHUNK_SIZE,
  getExportChunk,
  getExportJob,
  getJobForRecord,
  MAX_CHUNK_SIZE,
  recordCursorProgress,
  type ExportJob,
} from "./export-job-store";
import { getExportRecord } from "./export-store";
import { createCursor, verifyCursor } from "./export-cursor";

export interface ServeChunkResult {
  status: number;
  body: Record<string, unknown>;
}

function auditAppendChunk(recordId: string, action: string): void {
  auditLogAppend({
    timestamp: Date.now(),
    requestId: crypto.randomUUID(),
    issuer: "admin", // PII-free constant; per-admin id awaits session support
    commitment: recordId, // PII-free record id
    adminAction: action, // "export:chunk" | "export:chunk:done"
  });
}

/**
 * Serve one chunk of an export's chunked download.
 *
 * - `cursor: null` (first call) resolves-or-creates the job for `recordId` and
 *   returns chunk 0 + `nextCursor`. Once a job exists for a record, no-cursor
 *   calls reuse it (chunk 0 is re-served); `limit` affects only the first job
 *   creation for a record.
 * - `cursor: <token>` returns the chunk at the token's index. The token's
 *   `jobId` is bound to `recordId` (cross-check), preventing cross-record use.
 *
 * `limit` is a creation-time hint only (rows per chunk); it is ignored on
 * cursor calls. Clamping to `[1, MAX_CHUNK_SIZE]` happens here, not in the route.
 */
export async function serveExportChunk(params: {
  recordId: string;
  cursor: string | null;
  limit: number | null;
}): Promise<ServeChunkResult> {
  const { recordId, cursor, limit } = params;

  // Revocation lives only on ExportRecord.revokedAt (set by #783's
  // revokeExportRecord). No job.status === "revoked" branch exists.
  const record = await getExportRecord(recordId);
  if (!record) {
    return { status: 404, body: { error: "export not found" } };
  }
  if (record.revokedAt) {
    return { status: 403, body: { error: "export revoked" } };
  }

  let index: number;
  let resolvedJob: ExportJob;
  let isStart = false; // true only on the no-cursor (first) call

  if (cursor) {
    const v = verifyCursor(cursor); // never throws
    if (!v.ok) {
      return { status: 400, body: { error: "invalid cursor", reason: v.reason } };
    }
    const job = await getExportJob(v.jobId); // null on miss; never throws to us
    if (!job) {
      return { status: 404, body: { error: "export job not found" } };
    }
    if (job.recordId !== recordId) {
      return {
        status: 400,
        body: { error: "cursor does not match this export" },
      };
    }
    if (v.index < 0 || v.index >= job.totalChunks) {
      return { status: 400, body: { error: "cursor out of range" } };
    }
    index = v.index;
    resolvedJob = job;
    // cursor path appends NO audit entry
  } else {
    const existingJobId = await getJobForRecord(recordId);
    const existing = existingJobId ? await getExportJob(existingJobId) : null;
    // Once a job exists, reuse it (chunk 0 re-served); `limit` only affects the
    // first job creation for a record.
    resolvedJob =
      existing ?? (await createExportJob({
        recordId,
        rows: buildExportRows(record),
        chunkSize: Math.max(
          1,
          Math.min(limit ?? DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE),
        ),
      }));
    isStart = true;
    index = 0;
  }

  const job = resolvedJob;

  // --- all throwy DATA steps run BEFORE any audit append (no orphan entry on
  //     a mid-flow throw). createCursor (only on non-final chunks) and any
  //     shared-store read are the only throwy steps here; both precede the
  //     first append. ---
  const chunk = await getExportChunk(job.jobId, index);
  if (!chunk) {
    console.warn(`chunk ${index} missing for job ${job.jobId}`);
    return { status: 404, body: { error: "chunk not found" } };
  }
  const nextIndex = index + 1;
  const done = nextIndex >= job.totalChunks;
  const nextCursor = done ? null : createCursor(job.jobId, nextIndex);

  // --- best-effort progress handle: observability-only. A transient write
  //     failure is swallowed + console.warn-logged and never turns a
  //     successfully-fetched chunk into a 500. The signed token (not the
  //     handle) drives resume. ---
  await recordCursorProgress(job.jobId, index, done ? "completed" : "active").catch(
    (e) =>
      console.warn(
        `cursor progress write failed for job ${job.jobId}: ${(e as Error).message}`,
      ),
  );

  // --- audit append + persist: only on start and/or done; `appended` gates
  //     the persist so intermediate chunks append nothing and skip the persist
  //     entirely. ---
  let appended = false;
  if (isStart) {
    auditAppendChunk(recordId, "export:chunk");
    appended = true;
  }
  if (done) {
    auditAppendChunk(job.recordId, "export:chunk:done");
    appended = true;
  }
  if (appended) {
    await auditLogPersist();
  }

  return {
    status: 200,
    body: {
      jobId: job.jobId,
      index,
      totalChunks: job.totalChunks,
      chunk,
      nextCursor,
      done,
    },
  };
}
