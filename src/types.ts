export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

/** 冲突并列保留的单个版本（向量时钟签名用于去重与因果判断）。 */
export interface DraftChoice {
  value: string;
  clock: Record<string, number>;
  deviceId: string;
  deviceLabel: string;
  editedAt: string;
}

/** 未提交答案按句存储；clock 为合并上界，sourceClock 记录本值最后编辑设备自身的时钟，choices 为两边都改过的并列版本。 */
export interface SentenceDraft {
  value: string;
  clock: Record<string, number>;
  sourceClock: Record<string, number>;
  choices: DraftChoice[];
  updatedAt: string;
}

export interface LessonProgress {
  /** 键为 sentenceId */
  sentences: Record<string, SentenceDraft>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
  /** 提交当时绑定的逐句答案快照；与当前未提交答案逐句不一致即失效。 */
  snapshot: Record<string, string>;
  schemaVersion: 2;
}

export interface DeviceInfo {
  id: string;
  label: string;
}

export interface PersistedState {
  schemaVersion: 2;
  device: DeviceInfo;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface SyncBundle {
  kind: 'echostep-draft-sync';
  bundleVersion: 1;
  device: DeviceInfo;
  exportedAt: string;
  progress: Record<string, LessonProgress>;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}

/* ---------- 旧版本（schema v1）记录结构，升级后继续可读、可处理 ---------- */

export interface PersistedStateV1 {
  schemaVersion: 1;
  courses: Course[];
  attempts: Array<Omit<PracticeAttempt, 'snapshot' | 'schemaVersion'>>;
  progress: Record<string, {
    answers: Record<string, string>;
    activeSentenceId: string;
    updatedAt: string;
  }>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}
