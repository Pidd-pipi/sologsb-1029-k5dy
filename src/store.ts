import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import {
  annotateChoices,
  applyLocalEdit,
  buildBundle,
  createEmptyDraft,
  isSyncBundle,
  mergeProgress,
  resolveConflict,
  type MergeReport
} from './sync';
import type {
  DeviceInfo,
  Lesson,
  LessonProgress,
  PersistedState,
  PersistedStateV1,
  PracticeAttempt,
  SentenceDraft,
  SyncBundle
} from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function createDevice(): DeviceInfo {
  const id = `dev-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  const label = `${/Mobi|Android|iPhone/i.test(navigator.userAgent) ? '手机' : '电脑'} · ${new Date().toLocaleDateString('zh-CN')}`;
  return { id, label };
}

/** v1 → v2：未提交答案升级为带向量时钟的逐句草稿；旧作答仍可继续查看与处理。 */
function migrateV1(raw: PersistedStateV1): PersistedState {
  const device = createDevice();
  const progress: Record<string, LessonProgress> = {};
  Object.entries(raw.progress ?? {}).forEach(([lessonId, oldLesson]) => {
    const sentences: Record<string, SentenceDraft> = {};
    const when = oldLesson.updatedAt || new Date(0).toISOString();
    Object.entries(oldLesson.answers ?? {}).forEach(([sentenceId, answer]) => {
      if (!answer) return;
      // 旧版本没有向量时钟，给每条草稿以本机的初始计数 1。
      const clock = { [device.id]: 1 };
      sentences[sentenceId] = {
        value: answer,
        clock,
        sourceClock: clock,
        choices: [],
        updatedAt: when
      };
    });
    progress[lessonId] = {
      sentences,
      activeSentenceId: oldLesson.activeSentenceId,
      updatedAt: oldLesson.updatedAt
    };
  });

  return {
    schemaVersion: 2,
    device,
    courses: raw.courses,
    attempts: (raw.attempts ?? []).map((attempt) => ({
      ...attempt,
      // 旧记录没有快照字段：视为始终绑定当前草稿（不强行判失效），仍可继续处理。
      snapshot: {},
      schemaVersion: 2 as const
    })),
    progress,
    activeLessonId: raw.activeLessonId ?? '',
    activeSentenceId: raw.activeSentenceId ?? '',
    theme: raw.theme ?? 'light',
    fontScale: raw.fontScale ?? 1,
    role: raw.role ?? 'learner'
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState | PersistedStateV1;
      if (parsed.schemaVersion === 2) {
        if (!parsed.device?.id) parsed.device = createDevice();
        // 兼容开发期缺少 sourceClock 的草稿：用合并上界回填。
        Object.values(parsed.progress ?? {}).forEach((lesson) => {
          Object.values(lesson.sentences ?? {}).forEach((draft) => {
            if (!draft.sourceClock) draft.sourceClock = { ...draft.clock };
          });
        });
        return parsed as PersistedState;
      }
      if (parsed.schemaVersion === 1) {
        const migrated = migrateV1(parsed);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return { ...createInitialState(), device: createDevice() };
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
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

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

export function ensureProgress(lessonId: string, firstSentenceId: string): LessonProgress {
  const existing = state.progress[lessonId];
  if (existing) return existing;
  const created: LessonProgress = {
    sentences: {},
    activeSentenceId: firstSentenceId,
    updatedAt: new Date().toISOString()
  };
  state.progress[lessonId] = created;
  return created;
}

export function getSentenceDraft(lessonId: string, sentenceId: string): SentenceDraft {
  return state.progress[lessonId]?.sentences[sentenceId] ?? createEmptyDraft();
}

/** 学生在某设备上编辑一句答案：推进本设备时钟，同时使绑定该练习记录的旧结果失效。 */
export function setSentenceAnswer(lessonId: string, sentenceId: string, value: string) {
  const lesson = lessonById(lessonId);
  const firstSentenceId = lesson?.sentences[0].id ?? sentenceId;
  const progress = ensureProgress(lessonId, firstSentenceId);
  const current = progress.sentences[sentenceId] ?? createEmptyDraft();
  if (current.value === value) return; // 仅切换句子或输入相同内容，不推进时钟、不解除冲突
  progress.sentences[sentenceId] = applyLocalEdit(current, value, state.device.id, new Date().toISOString());
  progress.activeSentenceId = sentenceId;
  progress.updatedAt = new Date().toISOString();
}

/** 学生在并列版本中做出选择，冲突解除。 */
export function chooseDraftVersion(lessonId: string, sentenceId: string, index: number) {
  const draft = state.progress[lessonId]?.sentences[sentenceId];
  const choice = draft?.choices[index];
  if (!draft || !choice) return;
  state.progress[lessonId].sentences[sentenceId] = resolveConflict(draft, choice);
  state.progress[lessonId].updatedAt = new Date().toISOString();
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

export function setTeacherFeedback(attemptId: string, feedback: string) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  if (attempt) attempt.teacherFeedback = feedback;
}

/* ---------- 结果失效：答案改动后，重新确认前不进入统计和导出 ---------- */

/**
 * 逐词结果与教师反馈绑定提交当时的练习记录。当前草稿任一句与快照不同即失效；
 * schema v1 升级而来的旧记录没有快照，仍可继续查看和处理。
 */
export function isAttemptStale(attempt: PracticeAttempt): boolean {
  const current = state.progress[attempt.lessonId]?.sentences ?? {};
  return attempt.sentenceAttempts.some((sentence) => {
    const snapshot = attempt.snapshot?.[sentence.sentenceId];
    if (snapshot === undefined) return false; // v1 旧记录
    const present = current[sentence.sentenceId];
    const currentValue = present ? present.value : '';
    return (present?.choices.length ?? 0) > 0 || currentValue !== snapshot;
  });
}

export const currentAttempts = () => state.attempts.filter((attempt) => !isAttemptStale(attempt));

/** 用当前草稿重新确认（重新生成）一次失效记录前，统计与导出只看有效记录。 */
export function exportRecords(includeStale = false): string {
  const attempts = includeStale ? state.attempts : currentAttempts();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    note: includeStale ? '包含已失效的旧记录' : '仅包含答案未再改动的有效记录',
    attempts,
    progress: state.progress
  }, null, 2);
}

/* ---------- 跨设备离线同步 ---------- */

export function exportSyncBundle(): string {
  return JSON.stringify(buildBundle(state.device, state.progress), null, 2);
}

export function importSyncBundle(text: string): MergeReport {
  const parsed: unknown = JSON.parse(text);
  if (!isSyncBundle(parsed)) {
    throw new Error('文件不是 EchoStep 草稿同步包');
  }
  const bundle: SyncBundle = parsed;
  const labels: Record<string, string> = {
    [bundle.device.id]: bundle.device.label,
    [state.device.id]: state.device.label
  };
  annotateChoices(bundle.progress, labels);
  const { progress, report } = mergeProgress(state.progress, bundle.progress);
  state.progress = progress;
  // 合并过程中新产生的并列版本也要补上设备名。
  annotateChoices(state.progress, labels);
  persist();
  return report;
}

export function renameDevice(label: string) {
  state.device.label = label.trim() || state.device.label;
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
