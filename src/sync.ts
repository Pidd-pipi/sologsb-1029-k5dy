import type { DraftChoice, LessonProgress, SentenceDraft, SyncBundle } from './types';

/**
 * 未提交草稿的逐句离线合并（向量时钟）。
 *
 * 每句草稿同时维护两个时钟：
 * - clock       ：本设备已知的“合并上界”（知识向量），只随同步增长，用于判断因果/并发；
 * - sourceClock ：当前 value 这个具体文本最后一次产生时，其来源修订的因果时钟。
 *
 * 规则：
 * - 只在一侧改过（sourceClock 之间存在因果）：自动接续较新一侧，不建冲突；
 * - 两边都改过（sourceClock 并发）且内容不同：并列放入 choices 供学生选择；
 * - 内容相同：自动收敛，不建冲突；
 * - 同一份同步包重复导入（同一设备重复上线）：clock+内容 签名去重，不重复建冲突；
 * - 学生选定版本后：sourceClock 升级为合并上界，回传对端时自动接续，旧冲突不复活。
 */

export function createEmptyDraft(): SentenceDraft {
  return { value: '', clock: {}, sourceClock: {}, choices: [], updatedAt: '' };
}

function isEmptyDraft(draft: SentenceDraft): boolean {
  return !draft.value && !Object.keys(draft.clock).length && !Object.keys(draft.sourceClock).length && !draft.choices.length;
}

/** 本设备对某句做了一次编辑：在当前值的来源时钟上推进本设备分量。 */
export function applyLocalEdit(draft: SentenceDraft, value: string, deviceId: string, when: string): SentenceDraft {
  const sourceClock = { ...draft.sourceClock };
  sourceClock[deviceId] = (sourceClock[deviceId] ?? 0) + 1;
  const clock = mergeClock(draft.clock, sourceClock);
  return { value, clock, sourceClock, choices: [], updatedAt: when };
}

/** 学生从并列版本中选定一句：来源时钟升级为合并上界，冲突解除且回传不再冲突。 */
export function resolveConflict(draft: SentenceDraft, choice: DraftChoice): SentenceDraft {
  const sourceClock = mergeClock(draft.clock, choice.clock);
  return { value: choice.value, clock: { ...sourceClock }, sourceClock, choices: [], updatedAt: choice.editedAt };
}

type ClockOrder = 'before' | 'after' | 'equal' | 'concurrent';

export function compareClocks(a: Record<string, number>, b: Record<string, number>): ClockOrder {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aLess = false;
  let bLess = false;
  keys.forEach((key) => {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av < bv) aLess = true;
    if (av > bv) bLess = true;
  });
  if (!aLess && !bLess) return 'equal';
  if (aLess && !bLess) return 'before';
  if (bLess && !aLess) return 'after';
  return 'concurrent';
}

function mergeClock(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((key) => {
    out[key] = Math.max(a[key] ?? 0, b[key] ?? 0);
  });
  return out;
}

function clockSignature(clock: Record<string, number>): string {
  return Object.keys(clock).sort().map((key) => `${key}:${clock[key]}`).join(',');
}

/** 并列版本以“来源时钟 + 内容”为身份；owner 只是展示用的派生信息。 */
export function choiceSignature(choice: DraftChoice): string {
  return `${clockSignature(choice.clock)}=${choice.value}`;
}

/** 取来源时钟中计数严格最大的设备作为该版本最后编辑者。 */
function pickOwner(clock: Record<string, number>): string {
  let owner = '';
  let best = 0;
  Object.entries(clock).forEach(([deviceId, count]) => {
    if (count > best) {
      best = count;
      owner = deviceId;
    }
  });
  return owner;
}

function latestEdited(a: string, b: string): string {
  return a >= b ? a : b;
}

/** 合并同一句的两个草稿版本。local 为本机当前版本，remote 为同步包中的版本。 */
export function mergeSentenceDraft(local: SentenceDraft, remote: SentenceDraft): SentenceDraft {
  if (isEmptyDraft(remote)) return local;
  if (isEmptyDraft(local)) {
    return {
      ...remote,
      clock: { ...remote.clock },
      sourceClock: { ...remote.sourceClock },
      choices: remote.choices.map((choice) => ({ ...choice, clock: { ...choice.clock } }))
    };
  }

  const clock = mergeClock(local.clock, remote.clock);
  const updatedAt = latestEdited(local.updatedAt, remote.updatedAt);

  const order = compareClocks(local.sourceClock, remote.sourceClock);

  // 汇总双方已并列保留、且在新合并世界里仍然“待定”（不被任一侧当前值包含）的版本。
  const pending: DraftChoice[] = [];
  const seen = new Set<string>();
  const addChoice = (choice: DraftChoice) => {
    const signature = choiceSignature(choice);
    if (seen.has(signature)) return;
    seen.add(signature);
    pending.push({ ...choice, clock: { ...choice.clock } });
  };
  const considerChoice = (choice: DraftChoice) => {
    // 已被本机当前值或远端当前值的来源历史包含：学生已选过或它已被新修订取代，丢弃。
    if (compareClocks(choice.clock, local.sourceClock) !== 'after') return;
    if (compareClocks(choice.clock, remote.sourceClock) !== 'after') return;
    addChoice(choice);
  };
  local.choices.forEach(considerChoice);
  remote.choices.forEach(considerChoice);

  if (order === 'before') {
    // 远端值更新（包含本机当前值的全部来源历史）：自动接续远端。
    return { value: remote.value, clock, sourceClock: { ...remote.sourceClock }, choices: pending, updatedAt };
  }
  if (order === 'after') {
    // 本机值更新：保留本机。
    return { value: local.value, clock, sourceClock: { ...local.sourceClock }, choices: pending, updatedAt };
  }
  if (order === 'equal' && local.value === remote.value) {
    // 同一修订：内容必然一致，直接收敛。
    return { value: local.value, clock, sourceClock: { ...local.sourceClock }, choices: pending, updatedAt };
  }

  // 并发（或极端情况下同钟不同值）：两边都改过。
  if (local.value === remote.value) {
    // 两边独立改成相同内容：自动收敛，来源取并集上界，之后不再冲突。
    return { value: local.value, clock, sourceClock: mergeClock(local.sourceClock, remote.sourceClock), choices: pending, updatedAt };
  }

  // 内容不同：并列保留两侧当前值供学生选择；签名去重保证同一设备重复上线不重复建冲突。
  addChoice({
    value: local.value,
    clock: { ...local.sourceClock },
    deviceId: pickOwner(local.sourceClock),
    deviceLabel: '',
    editedAt: local.updatedAt
  });
  addChoice({
    value: remote.value,
    clock: { ...remote.sourceClock },
    deviceId: pickOwner(remote.sourceClock),
    deviceLabel: '',
    editedAt: remote.updatedAt
  });

  // 当前值保留本机内容，但 choices 非空；学生显式选定（resolveConflict）后冲突才解除。
  return { value: local.value, clock, sourceClock: { ...local.sourceClock }, choices: pending, updatedAt };
}

export interface MergeReport {
  lessonsTouched: number;
  sentencesMerged: number;
  conflicts: Array<{ lessonId: string; sentenceId: string }>;
}

/** 把一份同步包里的全部课程草稿并入本机进度。 */
export function mergeProgress(
  localProgress: Record<string, LessonProgress>,
  incoming: Record<string, LessonProgress>
): { progress: Record<string, LessonProgress>; report: MergeReport } {
  const merged: Record<string, LessonProgress> = { ...localProgress };
  const report: MergeReport = { lessonsTouched: 0, sentencesMerged: 0, conflicts: [] };

  Object.entries(incoming).forEach(([lessonId, remoteLesson]) => {
    const localLesson = merged[lessonId];
    const sentenceIds = new Set([
      ...Object.keys(localLesson?.sentences ?? {}),
      ...Object.keys(remoteLesson.sentences ?? {})
    ]);
    if (!sentenceIds.size) return;

    const nextSentences: Record<string, SentenceDraft> = {};
    let touched = false;

    sentenceIds.forEach((sentenceId) => {
      const before = localLesson?.sentences[sentenceId];
      const remoteSentence = remoteLesson.sentences[sentenceId];
      if (!remoteSentence) {
        if (before) nextSentences[sentenceId] = before;
        return;
      }
      const result = mergeSentenceDraft(before ?? createEmptyDraft(), remoteSentence);
      nextSentences[sentenceId] = result;
      if (!before
        || before.value !== result.value
        || before.choices.length !== result.choices.length
        || compareClocks(before.sourceClock, result.sourceClock) !== 'equal') {
        touched = true;
      }
      if (result.choices.length) report.conflicts.push({ lessonId, sentenceId });
      report.sentencesMerged += 1;
    });

    const localActive = localLesson?.activeSentenceId;
    const preferRemote = !localLesson
      || (localLesson.updatedAt < remoteLesson.updatedAt && sentenceIds.has(remoteLesson.activeSentenceId));
    const activeSentenceId = preferRemote
      ? remoteLesson.activeSentenceId
      : (localActive && sentenceIds.has(localActive) ? localActive : remoteLesson.activeSentenceId);

    merged[lessonId] = {
      sentences: nextSentences,
      activeSentenceId,
      updatedAt: latestEdited(localLesson?.updatedAt ?? '', remoteLesson.updatedAt)
    };
    if (touched) report.lessonsTouched += 1;
  });

  return { progress: merged, report };
}

/** 给草稿中缺少设备标签的版本补上标签（导出方与本机已知设备名）。 */
export function annotateChoices(
  progress: Record<string, LessonProgress>,
  labels: Record<string, string>
): void {
  Object.values(progress).forEach((lesson) => {
    Object.values(lesson.sentences).forEach((draft) => {
      draft.choices.forEach((choice) => {
        if (!choice.deviceLabel) choice.deviceLabel = labels[choice.deviceId] ?? '另一台设备';
      });
    });
  });
}

export function buildBundle(
  device: { id: string; label: string },
  progress: Record<string, LessonProgress>
): SyncBundle {
  const snapshot = structuredClone(progress);
  annotateChoices(snapshot, { [device.id]: device.label });
  return {
    kind: 'echostep-draft-sync',
    bundleVersion: 1,
    device: { ...device },
    exportedAt: new Date().toISOString(),
    progress: snapshot
  };
}

export function isSyncBundle(value: unknown): value is SyncBundle {
  const candidate = value as Partial<SyncBundle> | null;
  return !!candidate && candidate.kind === 'echostep-draft-sync' && typeof candidate.device?.id === 'string' && !!candidate.progress;
}
