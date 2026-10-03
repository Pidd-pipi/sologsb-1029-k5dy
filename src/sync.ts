import type { DraftConflict, DraftConflictOption, SentenceEditMeta } from './types';

const DEVICE_KEY = 'sologsb-1029-device-id';
/**
 * 模拟云端的草稿同步点。纯前端阶段没有真正的服务器，
 * 同源各标签页共享这个 localStorage 键，可真实演练「手机 + 电脑」两端同步；
 * 将来接后端时只需替换 readCloud / writeCloud 两个读写口。
 */
export const CLOUD_KEY = 'sologsb-1029-sync-cloud-v1';

export interface CloudSentence {
  value: string;
  updatedBy: string;
  updatedAt: string;
}

export interface CloudLesson {
  sentences: Record<string, CloudSentence>;
  updatedAt: string;
}

export interface CloudStore {
  schemaVersion: 1;
  lessons: Record<string, CloudLesson>;
}

const hasStorage = () => typeof localStorage !== 'undefined';

export function getDeviceId(): string {
  if (!hasStorage()) return 'dev-memory';
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // 存储不可用时退化为会话内 id，合并逻辑不受影响
    }
  }
  return id;
}

export function readCloud(): CloudStore {
  try {
    if (hasStorage()) {
      const raw = localStorage.getItem(CLOUD_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CloudStore;
        if (parsed && typeof parsed === 'object' && parsed.lessons) return parsed;
      }
    }
  } catch {
    // 云端缓存损坏时按空库处理，下次同步会重建
  }
  return { schemaVersion: 1, lessons: {} };
}

export function writeCloud(cloud: CloudStore): void {
  try {
    if (hasStorage()) localStorage.setItem(CLOUD_KEY, JSON.stringify(cloud));
  } catch {
    // 存储满或不可用时放弃本次上传，本地草稿不丢
  }
}

export interface MergeInput {
  lessonId: string;
  deviceId: string;
  now: string;
  /** 本机当前各句答案 */
  local: Record<string, string>;
  /** 本机各句最后修改信息 */
  localMeta: Record<string, SentenceEditMeta>;
  /** 上次成功同步的快照（三路合并基准） */
  base: Record<string, string>;
  /** 云端各句草稿 */
  remote: Record<string, CloudSentence>;
  /** 尚未解决的冲突，用于幂等去重 */
  pendingConflicts: DraftConflict[];
}

export interface MergeResult {
  /** 合并后的本机答案 */
  answers: Record<string, string>;
  /** 合并后的同步基准 */
  base: Record<string, string>;
  /** 需要写入云端的句子 */
  cloudWrites: Record<string, CloudSentence>;
  /** 合并后的待处理冲突列表 */
  conflicts: DraftConflict[];
  /** 从云端自动接上的句子 */
  appliedFromRemote: string[];
  /** 上传到云端的句子 */
  pushed: string[];
  /** 本次合并新产生的冲突（不含复用的旧冲突） */
  newConflicts: DraftConflict[];
  /** 本地是否发生任何可见变化 */
  changed: boolean;
}

const hashText = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
};

/** 冲突 id 只由课程、句子与两侧取值决定，与同步次数无关：同一设备重复上线不会重复建冲突 */
export const conflictIdFor = (lessonId: string, sentenceId: string, values: [string, string]): string =>
  `cf-${hashText(`${lessonId}|${sentenceId}|${JSON.stringify([...values].sort())}`)}`;

/**
 * 逐句三路合并未提交草稿：
 * - 只有一侧改过 → 自动接上另一侧的结果；
 * - 两侧都改过且不一致 → 并列保留为冲突，等学生选择，基准保持原值使冲突在解决前持续存在；
 * - 两侧改成一样 → 自动收敛。
 */
export function mergeLessonDraft(input: MergeInput): MergeResult {
  const { lessonId, deviceId, now, local, localMeta, base, remote, pendingConflicts } = input;
  const answers: Record<string, string> = { ...local };
  const nextBase: Record<string, string> = {};
  const cloudWrites: Record<string, CloudSentence> = {};
  const appliedFromRemote: string[] = [];
  const pushed: string[] = [];
  const nextConflicts: DraftConflict[] = [];
  const newConflicts: DraftConflict[] = [];
  const processed = new Set<string>();
  const existingById = new Map(pendingConflicts.map((conflict) => [conflict.id, conflict]));

  const sentenceIds = new Set([...Object.keys(local), ...Object.keys(base), ...Object.keys(remote)]);
  for (const sentenceId of sentenceIds) {
    const baseValue = base[sentenceId] ?? '';
    const localValue = local[sentenceId] ?? '';
    const remoteSentence = remote[sentenceId];
    const remoteValue = remoteSentence?.value ?? '';
    const localChanged = localValue !== baseValue;
    const remoteChanged = remoteValue !== baseValue;

    if (!localChanged && !remoteChanged) {
      nextBase[sentenceId] = baseValue;
      continue;
    }
    processed.add(sentenceId);

    if (localChanged && !remoteChanged) {
      // 只有本机改过：上传云端
      nextBase[sentenceId] = localValue;
      cloudWrites[sentenceId] = { value: localValue, updatedBy: deviceId, updatedAt: now };
      pushed.push(sentenceId);
      continue;
    }
    if (!localChanged && remoteChanged) {
      // 只有云端改过：自动接到本机
      answers[sentenceId] = remoteValue;
      nextBase[sentenceId] = remoteValue;
      appliedFromRemote.push(sentenceId);
      continue;
    }
    if (localValue === remoteValue) {
      // 两侧改成一样：自动收敛
      nextBase[sentenceId] = localValue;
      continue;
    }

    // 两侧都改过且不一致：并列保留，等学生逐句选择
    nextBase[sentenceId] = baseValue;
    const localOption: DraftConflictOption = {
      value: localValue,
      source: 'local',
      updatedBy: localMeta[sentenceId]?.updatedBy ?? deviceId,
      updatedAt: localMeta[sentenceId]?.updatedAt ?? ''
    };
    const remoteOption: DraftConflictOption = {
      value: remoteValue,
      source: 'remote',
      updatedBy: remoteSentence?.updatedBy ?? '',
      updatedAt: remoteSentence?.updatedAt ?? ''
    };
    const id = conflictIdFor(lessonId, sentenceId, [localValue, remoteValue]);
    const reused = existingById.get(id);
    const conflict: DraftConflict = reused ?? { id, lessonId, sentenceId, options: [localOption, remoteOption], createdAt: now };
    nextConflicts.push(conflict);
    if (!reused) newConflicts.push(conflict);
  }

  // 本轮没动到的句子保留旧冲突；已处理但不再冲突的（如对方回退、两侧收敛）自动关闭
  const kept = pendingConflicts.filter((conflict) => !processed.has(conflict.sentenceId));
  const conflicts = [...kept, ...nextConflicts];
  const changed = appliedFromRemote.length > 0
    || pushed.length > 0
    || newConflicts.length > 0
    || conflicts.length !== pendingConflicts.length;

  return { answers, base: nextBase, cloudWrites, conflicts, appliedFromRemote, pushed, newConflicts, changed };
}
