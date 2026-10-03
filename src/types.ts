export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
/** valid = 与当前答案一致，计入统计与导出；stale = 提交后答案又被改动，等待重新提交确认 */
export type AttemptStatus = 'valid' | 'stale';

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

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
  /** 逐词结果与教师反馈只绑定提交那一刻的练习记录 */
  status: AttemptStatus;
  /** 提交时草稿的修订号，答案再变动后该记录即失效 */
  draftRevision: number;
}

export interface SentenceEditMeta {
  updatedAt: string;
  updatedBy: string;
}

export interface DraftConflictOption {
  value: string;
  source: 'local' | 'remote';
  updatedBy: string;
  updatedAt: string;
}

/** 同一句话在两侧各改过一次时并列保留，等学生选择 */
export interface DraftConflict {
  /** 由课程、句子与两侧取值内容决定：同一设备重复上线算出的 id 相同，不会重复建冲突 */
  id: string;
  lessonId: string;
  sentenceId: string;
  options: [DraftConflictOption, DraftConflictOption];
  createdAt: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
  /** 答案每变动一次 +1，提交时快照到 attempt.draftRevision */
  revision: number;
  /** 每句最后一次修改的时间与设备 */
  sentenceMeta: Record<string, SentenceEditMeta>;
  /** 上次成功同步时各句的值，作为三路合并的基准 */
  syncBase: Record<string, string>;
  /** 待学生逐句选择的同步冲突 */
  conflicts: DraftConflict[];
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
  lastSyncAt: string;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
