import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import { migratePersistedState } from './migrate';
import { getDeviceId, mergeLessonDraft, readCloud, writeCloud } from './sync';
import type { Lesson, LessonProgress, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

const hasStorage = () => typeof localStorage !== 'undefined';

function loadState(): PersistedState {
  try {
    if (hasStorage()) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        // 旧版本记录在这里升级，升级后继续处理而不是丢弃
        const migrated = migratePersistedState(JSON.parse(raw));
        if (migrated) return migrated;
      }
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    if (!hasStorage()) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function createProgress(lessonId: string): LessonProgress {
  return {
    answers: {},
    activeSentenceId: lessonById(lessonId)?.sentences[0]?.id ?? '',
    updatedAt: new Date().toISOString(),
    revision: 0,
    sentenceMeta: {},
    syncBase: {},
    conflicts: []
  };
}

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

/**
 * 答案变动后，该课所有仍有效的练习记录立即失效：
 * 逐词结果与教师反馈只绑定提交那一刻的记录，重新提交确认前不进入统计与导出。
 */
export function invalidateLessonAttempts(lessonId: string): number {
  let count = 0;
  for (const attempt of state.attempts) {
    if (attempt.lessonId === lessonId && attempt.status === 'valid') {
      attempt.status = 'stale';
      count += 1;
    }
  }
  return count;
}

/** 记录一句答案的变动（输入、合并接上、冲突选择都走这里），返回是否真的发生了变化 */
export function touchAnswer(lessonId: string, sentenceId: string, value: string): boolean {
  const progress = state.progress[lessonId];
  if (!progress) return false;
  if ((progress.answers[sentenceId] ?? '') === value) return false;
  const now = new Date().toISOString();
  progress.answers[sentenceId] = value;
  progress.sentenceMeta[sentenceId] = { updatedAt: now, updatedBy: getDeviceId() };
  progress.updatedAt = now;
  progress.revision += 1;
  invalidateLessonAttempts(lessonId);
  return true;
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export const validAttempts = (): PracticeAttempt[] => state.attempts.filter((attempt) => attempt.status === 'valid');
export const latestAttemptForLesson = (lessonId: string): PracticeAttempt | undefined =>
  state.attempts.find((attempt) => attempt.lessonId === lessonId);

export interface SyncSummary {
  applied: number;
  pushed: number;
  conflicts: number;
}

/**
 * 回网后把本机未提交草稿与云端草稿逐句三路合并：
 * 只改一侧的句自动接上，两侧都改的句并列保留为冲突，重复同步幂等。
 */
export function syncNow(): SyncSummary {
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const cloud = readCloud();
  const summary: SyncSummary = { applied: 0, pushed: 0, conflicts: 0 };
  let cloudDirty = false;
  const lessonIds = new Set([...Object.keys(state.progress), ...Object.keys(cloud.lessons)]);

  for (const lessonId of lessonIds) {
    if (!lessonById(lessonId)) continue;
    const progress = state.progress[lessonId] ?? createProgress(lessonId);
    const result = mergeLessonDraft({
      lessonId,
      deviceId,
      now,
      local: progress.answers,
      localMeta: progress.sentenceMeta,
      base: progress.syncBase,
      remote: cloud.lessons[lessonId]?.sentences ?? {},
      pendingConflicts: progress.conflicts
    });

    if (Object.keys(result.cloudWrites).length) {
      const cloudLesson = cloud.lessons[lessonId] ?? { sentences: {}, updatedAt: now };
      Object.assign(cloudLesson.sentences, result.cloudWrites);
      cloudLesson.updatedAt = now;
      cloud.lessons[lessonId] = cloudLesson;
      cloudDirty = true;
    }

    if (!result.changed) continue;
    progress.answers = result.answers;
    progress.syncBase = result.base;
    progress.conflicts = result.conflicts;
    for (const sentenceId of result.appliedFromRemote) {
      const remoteMeta = cloud.lessons[lessonId]?.sentences[sentenceId];
      progress.sentenceMeta[sentenceId] = {
        updatedAt: remoteMeta?.updatedAt ?? now,
        updatedBy: remoteMeta?.updatedBy ?? deviceId
      };
    }
    if (result.appliedFromRemote.length) {
      // 合并改动了本机答案，同样让旧结果失效
      progress.revision += 1;
      progress.updatedAt = now;
      invalidateLessonAttempts(lessonId);
    }
    state.progress[lessonId] = progress;
    summary.applied += result.appliedFromRemote.length;
    summary.pushed += result.pushed.length;
    summary.conflicts += result.newConflicts.length;
  }

  // 云端没变化就不写，避免多标签页之间互相触发空同步
  if (cloudDirty) writeCloud(cloud);
  state.lastSyncAt = now;
  persist();
  return summary;
}

/** 学生在冲突中选定一份：写回本机草稿、同步基准与云端，冲突关闭 */
export function resolveConflict(lessonId: string, conflictId: string, value: string): boolean {
  const progress = state.progress[lessonId];
  const conflict = progress?.conflicts.find((item) => item.id === conflictId);
  if (!progress || !conflict) return false;
  const now = new Date().toISOString();
  touchAnswer(lessonId, conflict.sentenceId, value);
  progress.syncBase[conflict.sentenceId] = value;
  const cloud = readCloud();
  const cloudLesson = cloud.lessons[lessonId] ?? { sentences: {}, updatedAt: now };
  cloudLesson.sentences[conflict.sentenceId] = { value, updatedBy: getDeviceId(), updatedAt: now };
  cloudLesson.updatedAt = now;
  cloud.lessons[lessonId] = cloudLesson;
  writeCloud(cloud);
  progress.conflicts = progress.conflicts.filter((item) => item.id !== conflictId);
  persist();
  return true;
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

export function exportRecords(): string {
  const valid = validAttempts();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    schemaVersion: state.schemaVersion,
    stats: {
      validAttempts: valid.length,
      excludedStaleAttempts: state.attempts.length - valid.length
    },
    attempts: valid,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
