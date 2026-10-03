import type { LessonProgress, PersistedState, PracticeAttempt } from './types';

/** schemaVersion 1 的进度结构（无修订号、无同步字段） */
interface LessonProgressV1 {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

type AttemptV1 = Omit<PracticeAttempt, 'status' | 'draftRevision'> & Partial<Pick<PracticeAttempt, 'status' | 'draftRevision'>>;

interface PersistedStateV1 extends Omit<PersistedState, 'schemaVersion' | 'attempts' | 'progress' | 'lastSyncAt'> {
  schemaVersion: 1;
  attempts: AttemptV1[];
  progress: Record<string, LessonProgressV1>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** 旧记录默认有效：它们是当时已确认的练习结果，升级后照常进入统计与导出 */
function normalizeAttempt(attempt: AttemptV1): PracticeAttempt {
  return {
    ...attempt,
    teacherFeedback: attempt.teacherFeedback ?? '',
    status: attempt.status ?? 'valid',
    draftRevision: attempt.draftRevision ?? 0
  };
}

function normalizeProgress(progress: Partial<LessonProgress> & Partial<LessonProgressV1>): LessonProgress {
  const answers = progress.answers ?? {};
  const legacyMeta = Object.fromEntries(
    Object.keys(answers).map((id) => [id, { updatedAt: progress.updatedAt ?? '', updatedBy: 'legacy' }])
  );
  return {
    answers,
    activeSentenceId: progress.activeSentenceId ?? '',
    updatedAt: progress.updatedAt ?? '',
    revision: progress.revision ?? 0,
    sentenceMeta: progress.sentenceMeta ?? legacyMeta,
    syncBase: progress.syncBase ?? {},
    conflicts: progress.conflicts ?? []
  };
}

/**
 * 把本地持久化数据升级到当前 schemaVersion。
 * 返回 null 表示数据完全不可用，由调用方回退到初始示例数据。
 */
export function migratePersistedState(raw: unknown): PersistedState | null {
  if (!isRecord(raw) || !Array.isArray(raw.courses)) return null;

  if (raw.schemaVersion === 1) {
    const legacy = raw as unknown as PersistedStateV1;
    return {
      ...legacy,
      schemaVersion: 2,
      attempts: (legacy.attempts ?? []).map(normalizeAttempt),
      progress: Object.fromEntries(
        Object.entries(legacy.progress ?? {}).map(([lessonId, progress]) => [lessonId, normalizeProgress(progress)])
      ),
      lastSyncAt: ''
    };
  }

  if (raw.schemaVersion === 2) {
    const current = raw as unknown as PersistedState;
    return {
      ...current,
      attempts: (current.attempts ?? []).map(normalizeAttempt),
      progress: Object.fromEntries(
        Object.entries(current.progress ?? {}).map(([lessonId, progress]) => [lessonId, normalizeProgress(progress)])
      ),
      lastSyncAt: current.lastSyncAt ?? ''
    };
  }

  return null;
}
