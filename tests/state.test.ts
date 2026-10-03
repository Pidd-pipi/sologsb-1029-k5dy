import assert from 'node:assert/strict';
import { conflictIdFor, getDeviceId, mergeLessonDraft, readCloud, writeCloud, type MergeInput } from '../src/sync';
import { migratePersistedState } from '../src/migrate';
import { createProgress, exportRecords, saveAttempt, state, syncNow, resolveConflict, touchAnswer } from '../src/store';
import type { PracticeAttempt } from '../src/types';

// store.ts 在无 localStorage 环境下会安全回退，这里补上内存版以测试完整同步链路
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
}

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

const baseInput: MergeInput = {
  lessonId: 'L1',
  deviceId: 'devA',
  now: '2026-10-03T00:00:00.000Z',
  local: {},
  localMeta: {},
  base: {},
  remote: {},
  pendingConflicts: []
};

const validAttempt = (id: string, lessonId: string): PracticeAttempt => ({
  id,
  lessonId,
  lessonTitle: '课节',
  courseTitle: '课程',
  submittedAt: '2026-10-03T00:00:00.000Z',
  score: 90,
  sentenceAttempts: [],
  teacherFeedback: '',
  status: 'valid',
  draftRevision: 0
});

function resetStore() {
  localStorage.clear();
  state.attempts.splice(0);
  for (const key of Object.keys(state.progress)) delete state.progress[key];
  state.lastSyncAt = '';
}

// ---------- 逐句三路合并 ----------

test('只有本机改过的句自动上传到云端', () => {
  const r = mergeLessonDraft({ ...baseInput, local: { s1: 'hello' } });
  assert.deepEqual(r.pushed, ['s1']);
  assert.equal(r.cloudWrites.s1.value, 'hello');
  assert.equal(r.base.s1, 'hello');
  assert.equal(r.appliedFromRemote.length, 0);
  assert.equal(r.conflicts.length, 0);
});

test('只有云端改过的句自动接到本机', () => {
  const r = mergeLessonDraft({ ...baseInput, remote: { s2: { value: 'remote text', updatedBy: 'devB', updatedAt: 't' } } });
  assert.deepEqual(r.appliedFromRemote, ['s2']);
  assert.equal(r.answers.s2, 'remote text');
  assert.equal(r.base.s2, 'remote text');
});

test('两侧各改不同的句：各自自动接上，不产生冲突', () => {
  const r = mergeLessonDraft({
    ...baseInput,
    local: { s1: 'mine' },
    remote: { s2: { value: 'theirs', updatedBy: 'devB', updatedAt: 't' } }
  });
  assert.deepEqual(r.pushed, ['s1']);
  assert.deepEqual(r.appliedFromRemote, ['s2']);
  assert.equal(r.answers.s1, 'mine');
  assert.equal(r.answers.s2, 'theirs');
  assert.equal(r.conflicts.length, 0);
});

test('两侧改同一句：并列保留两份，本机草稿不被覆盖', () => {
  const r = mergeLessonDraft({
    ...baseInput,
    local: { s1: 'mine' },
    localMeta: { s1: { updatedAt: 't1', updatedBy: 'devA' } },
    remote: { s1: { value: 'theirs', updatedBy: 'devB', updatedAt: 't2' } }
  });
  assert.equal(r.answers.s1, 'mine');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.newConflicts.length, 1);
  assert.deepEqual(r.conflicts[0].options.map((o) => o.value).sort(), ['mine', 'theirs']);
  assert.deepEqual(r.conflicts[0].options.map((o) => o.source), ['local', 'remote']);
  assert.equal(r.cloudWrites.s1, undefined);
  assert.equal(r.base.s1, '');
});

test('同一设备重复同步不重复建冲突（幂等）', () => {
  const input: MergeInput = {
    ...baseInput,
    local: { s1: 'mine' },
    remote: { s1: { value: 'theirs', updatedBy: 'devB', updatedAt: 't2' } }
  };
  const first = mergeLessonDraft(input);
  const second = mergeLessonDraft({ ...input, base: first.base, pendingConflicts: first.conflicts });
  assert.equal(second.newConflicts.length, 0);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].id, first.conflicts[0].id);
  assert.equal(second.conflicts[0].createdAt, first.conflicts[0].createdAt);
  assert.equal(second.changed, false);
});

test('冲突 id 与两侧取值顺序无关', () => {
  assert.equal(conflictIdFor('L', 's', ['a', 'b']), conflictIdFor('L', 's', ['b', 'a']));
});

test('两侧改成一样：自动收敛，不建冲突', () => {
  const r = mergeLessonDraft({
    ...baseInput,
    local: { s1: 'same' },
    remote: { s1: { value: 'same', updatedBy: 'devB', updatedAt: 't' } }
  });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.base.s1, 'same');
});

test('对方回退到基准后，旧冲突自动关闭', () => {
  const first = mergeLessonDraft({
    ...baseInput,
    local: { s1: 'mine' },
    remote: { s1: { value: 'theirs', updatedBy: 'devB', updatedAt: 't' } }
  });
  const second = mergeLessonDraft({
    ...baseInput,
    local: { s1: 'mine' },
    base: first.base,
    remote: {},
    pendingConflicts: first.conflicts
  });
  assert.equal(second.conflicts.length, 0);
  assert.deepEqual(second.pushed, ['s1']);
});

// ---------- 旧版本记录升级 ----------

test('schemaVersion 1 的记录升级后仍能继续处理', () => {
  const v1 = {
    schemaVersion: 1,
    courses: [],
    attempts: [{ id: 'a1', lessonId: 'L1', lessonTitle: 't', courseTitle: 'c', submittedAt: 's', score: 80, sentenceAttempts: [], teacherFeedback: 'good' }],
    progress: { L1: { answers: { s1: 'ans' }, activeSentenceId: 's1', updatedAt: 'u' } },
    activeLessonId: '',
    activeSentenceId: '',
    theme: 'light',
    fontScale: 1,
    role: 'learner'
  };
  const migrated = migratePersistedState(v1);
  assert.ok(migrated);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.attempts[0].status, 'valid');
  assert.equal(migrated.attempts[0].draftRevision, 0);
  assert.equal(migrated.attempts[0].teacherFeedback, 'good');
  assert.equal(migrated.progress.L1.revision, 0);
  assert.equal(migrated.progress.L1.answers.s1, 'ans');
  assert.equal(migrated.progress.L1.sentenceMeta.s1.updatedBy, 'legacy');
  assert.deepEqual(migrated.progress.L1.syncBase, {});
  assert.deepEqual(migrated.progress.L1.conflicts, []);
});

test('v2 数据缺字段时补默认值，可直接继续处理', () => {
  const migrated = migratePersistedState({
    schemaVersion: 2,
    courses: [],
    attempts: [{ id: 'a', lessonId: 'L' }],
    progress: { L: { answers: { s1: 'x' } } }
  });
  assert.ok(migrated);
  assert.equal(migrated.attempts[0].status, 'valid');
  assert.equal(migrated.progress.L.revision, 0);
  assert.deepEqual(migrated.progress.L.syncBase, {});
  assert.equal(migrated.lastSyncAt, '');
});

test('无法识别的数据返回 null，由调用方回退到初始数据', () => {
  assert.equal(migratePersistedState(null), null);
  assert.equal(migratePersistedState('junk'), null);
  assert.equal(migratePersistedState({ schemaVersion: 99, courses: [] }), null);
});

// ---------- 结果失效与统计/导出 ----------

test('学生改动答案后旧结果立即失效，其他课不受影响', () => {
  resetStore();
  state.progress['airport-01'] = createProgress('airport-01');
  saveAttempt(validAttempt('a1', 'airport-01'));
  saveAttempt(validAttempt('a2', 'meeting-01'));
  const changed = touchAnswer('airport-01', 'airport-01-s1', 'new answer');
  assert.equal(changed, true);
  assert.equal(state.attempts.find((a) => a.id === 'a1')?.status, 'stale');
  assert.equal(state.attempts.find((a) => a.id === 'a2')?.status, 'valid');
  assert.equal(state.progress['airport-01'].revision, 1);
});

test('答案没有实际变化时不失效、不增修订号', () => {
  resetStore();
  const progress = createProgress('airport-01');
  progress.answers['airport-01-s1'] = 'same';
  state.progress['airport-01'] = progress;
  saveAttempt(validAttempt('a1', 'airport-01'));
  assert.equal(touchAnswer('airport-01', 'airport-01-s1', 'same'), false);
  assert.equal(state.attempts[0].status, 'valid');
  assert.equal(progress.revision, 0);
});

test('失效记录不进入导出，重新提交确认后恢复', () => {
  resetStore();
  state.progress['airport-01'] = createProgress('airport-01');
  saveAttempt(validAttempt('a1', 'airport-01'));
  touchAnswer('airport-01', 'airport-01-s1', 'changed');
  let exported = JSON.parse(exportRecords());
  assert.equal(exported.attempts.length, 0);
  assert.equal(exported.stats.excludedStaleAttempts, 1);
  saveAttempt(validAttempt('a2', 'airport-01'));
  exported = JSON.parse(exportRecords());
  assert.equal(exported.attempts.length, 1);
  assert.equal(exported.attempts[0].id, 'a2');
  assert.equal(exported.stats.validAttempts, 1);
});

// ---------- 端到端：手机 + 电脑离线续写后回网合并 ----------

test('syncNow：逐句合并、重复同步幂等、冲突选择后收敛', () => {
  resetStore();
  const progress = createProgress('airport-01');
  progress.answers['airport-01-s1'] = 'phone version';
  progress.sentenceMeta['airport-01-s1'] = { updatedAt: 't1', updatedBy: getDeviceId() };
  state.progress['airport-01'] = progress;
  saveAttempt(validAttempt('a1', 'airport-01'));

  // 另一台设备（电脑）离线改了同一句 + 另一句，并先一步上云
  writeCloud({
    schemaVersion: 1,
    lessons: {
      'airport-01': {
        updatedAt: 't2',
        sentences: {
          'airport-01-s1': { value: 'computer version', updatedBy: 'dev-computer', updatedAt: 't2' },
          'airport-01-s2': { value: 'computer s2', updatedBy: 'dev-computer', updatedAt: 't2' }
        }
      }
    }
  });

  const first = syncNow();
  assert.deepEqual(first, { applied: 1, pushed: 0, conflicts: 1 });
  const merged = state.progress['airport-01'];
  assert.equal(merged.answers['airport-01-s2'], 'computer s2'); // 只改一侧 → 自动接上
  assert.equal(merged.answers['airport-01-s1'], 'phone version'); // 两侧都改 → 本机草稿不被覆盖
  assert.equal(merged.conflicts.length, 1);
  assert.equal(state.attempts[0].status, 'stale'); // 合并改动答案 → 旧结果立即失效

  // 同一设备重复上线：不产生新冲突、不产生新改动
  const second = syncNow();
  assert.deepEqual(second, { applied: 0, pushed: 0, conflicts: 0 });
  assert.equal(state.progress['airport-01'].conflicts.length, 1);

  // 学生逐句选择云端那份
  const conflict = state.progress['airport-01'].conflicts[0];
  assert.equal(resolveConflict('airport-01', conflict.id, 'computer version'), true);
  assert.equal(state.progress['airport-01'].answers['airport-01-s1'], 'computer version');
  assert.equal(state.progress['airport-01'].conflicts.length, 0);
  assert.equal(readCloud().lessons['airport-01'].sentences['airport-01-s1'].value, 'computer version');

  // 再同步：彻底收敛，不再重复建冲突
  const third = syncNow();
  assert.deepEqual(third, { applied: 0, pushed: 0, conflicts: 0 });
  assert.equal(state.progress['airport-01'].conflicts.length, 0);
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部测试通过');
