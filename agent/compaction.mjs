// Map Pi compaction events to ACP compaction_update payloads.
// Pure and stateless: track `session.compactionId` at the call site.
import { randomUUID } from 'node:crypto';

function patch(session, update) {
  const compactionId = session.compactionId ?? randomUUID();
  session.compactionId = compactionId;
  return { compactionId, ...update };
}

export function handleCompactionEvent(session, record) {
  const { type } = record;

  if (type === 'compaction_start') {
    return patch(session, {
      status: 'in_progress',
      _meta: { pi: { reason: record.reason } },
    });
  }

  if (type === 'summarization_retry_scheduled' || type === 'summarization_retry_attempt_start') {
    if (record.source === 'branchSummary') return null;
    // Retries only make sense for a compaction already in progress; without a
    // start there is nothing to patch (and branch summaries carry no source).
    if (!session.compactionId) return null;
    return patch(session, {
      status: 'in_progress',
      _meta: { pi: { retry: { attempt: record.attempt, maxAttempts: record.maxAttempts, errorMessage: record.errorMessage } } },
    });
  }

  if (type === 'compaction_end') {
    const compactionId = session.compactionId ?? randomUUID();
    session.compactionId = null;
    const meta = {
      pi: {
        reason: record.reason,
        tokensBefore: record.result?.tokensBefore,
        estimatedTokensAfter: record.result?.estimatedTokensAfter,
        willRetry: Boolean(record.willRetry),
      },
    };
    if (record.aborted) return { compactionId, status: 'cancelled', _meta: meta };
    if (record.result) {
      const summary = record.result.summary
        ? [{ type: 'text', text: record.result.summary }]
        : undefined;
      return {
        compactionId,
        status: 'completed',
        ...(summary ? { summary } : {}),
        _meta: meta,
      };
    }
    return { compactionId, status: 'failed', error: record.errorMessage || '整理上下文失败', _meta: meta };
  }

  return null;
}
