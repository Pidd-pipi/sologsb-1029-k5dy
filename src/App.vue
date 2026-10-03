<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  chooseDraftVersion,
  courseForLesson,
  currentAttempts,
  ensureProgress,
  exportRecords,
  exportSyncBundle,
  getSentenceDraft,
  importSyncBundle,
  isAttemptStale,
  lessonById,
  persist,
  saveAttempt,
  setDownloaded,
  setSentenceAnswer,
  setTeacherFeedback,
  state,
  updateTokenClassification
} from './store';
import type { ErrorCategory, Lesson, PracticeAttempt, PracticeView, SentenceAttempt } from './types';
import { compareSentence, scoreAttempt, segmentText } from './utils';
import type { MergeReport } from './sync';

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(1);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
const syncFileInput = ref<HTMLInputElement | null>(null);
let toastTimer = 0;

const activeLesson = computed(() => lessonById(state.activeLessonId));
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const activeProgress = computed(() => activeLesson.value ? state.progress[activeLesson.value.id] : undefined);
const currentDraft = computed(() => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  return lesson && sentence ? getSentenceDraft(lesson.id, sentence.id) : undefined;
});
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
const lessonCompletion = computed(() => {
  if (!activeLesson.value) return 0;
  const answered = activeLesson.value.sentences.filter((sentence) => (activeProgress.value?.sentences[sentence.id]?.value ?? '').trim()).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const conflictCount = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson || !activeProgress.value) return 0;
  return lesson.sentences.filter((sentence) => (activeProgress.value?.sentences[sentence.id]?.choices.length ?? 0) > 0).length;
});
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultStale = computed(() => (resultAttempt.value ? isAttemptStale(resultAttempt.value) : false));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const teacherStale = computed(() => (teacherAttempt.value ? isAttemptStale(teacherAttempt.value) : false));
const totalWords = computed(() => currentAttempts().flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => currentAttempts().flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

watch(currentSentence, (sentence) => {
  currentAnswer.value = sentence ? getSentenceDraft(activeLesson.value!.id, sentence.id).value : '';
  segmentStart.value = 0;
  segmentEnd.value = sentence ? Math.max(0, segmentText(sentence.text).length - 1) : 0;
}, { immediate: true });

watch(currentAnswer, (value) => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  setSentenceAnswer(lesson.id, sentence.id, value);
});

watch(activeLesson, (lesson) => {
  if (!lesson) return;
  const progress = ensureProgress(lesson.id, lesson.sentences[0].id);
  state.activeLessonId = lesson.id;
  if (!lesson.sentences.some((sentence) => sentence.id === progress.activeSentenceId)) progress.activeSentenceId = lesson.sentences[0].id;
  state.activeSentenceId = progress.activeSentenceId;
  currentAnswer.value = progress.sentences[state.activeSentenceId]?.value ?? '';
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2600);
}

function startLesson(lesson: Lesson) {
  const progress = ensureProgress(lesson.id, lesson.sentences[0].id);
  state.activeLessonId = lesson.id;
  state.activeSentenceId = progress.activeSentenceId || lesson.sentences[0].id;
  currentAnswer.value = progress.sentences[state.activeSentenceId]?.value ?? '';
  view.value = 'practice';
  persist();
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  const target = lesson.sentences[index];
  state.activeSentenceId = target.id;
  const progress = state.progress[lesson.id];
  if (progress) {
    progress.activeSentenceId = target.id;
    progress.updatedAt = new Date().toISOString();
  }
  currentAnswer.value = progress?.sentences[target.id]?.value ?? '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pickVersion(index: number) {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  chooseDraftVersion(lesson.id, sentence.id, index);
  currentAnswer.value = getSentenceDraft(lesson.id, sentence.id).value;
  notify('已选定该版本，冲突已解除');
}

function buildSentenceAttempts(lesson: Lesson): SentenceAttempt[] {
  const progress = state.progress[lesson.id];
  return lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = progress?.sentences[sentence.id]?.value ?? '';
    const tokens = compareSentence(source, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return { sentenceId: sentence.id, source, answer, tokens, score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0 };
  });
}

function buildSnapshot(lesson: Lesson): Record<string, string> {
  const snapshot: Record<string, string> = {};
  lesson.sentences.forEach((sentence) => {
    snapshot[sentence.id] = state.progress[lesson.id]?.sentences[sentence.id]?.value ?? '';
  });
  return snapshot;
}

function submitLesson() {
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  const progress = state.progress[lesson.id];
  if (conflictCount.value > 0) {
    notify(`还有 ${conflictCount.value} 句双设备修改未选择，请先逐句选定版本`);
    return;
  }
  const answeredCount = lesson.sentences.filter((sentence) => (progress?.sentences[sentence.id]?.value ?? '').trim()).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;
  const sentenceAttempts = buildSentenceAttempts(lesson);
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: '',
    snapshot: buildSnapshot(lesson),
    schemaVersion: 2
  };
  saveAttempt(attempt);
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
  persist();
  notify('已提交，逐词结果已生成');
}

/** 答案改动导致旧结果失效后，用当前草稿重新确认一次，重新进入统计与导出。 */
function reconfirmAttempt() {
  const attempt = resultAttempt.value;
  const lesson = attempt ? lessonById(attempt.lessonId) : undefined;
  if (!attempt || !lesson) return;
  const stillConflicted = lesson.sentences.some((sentence) => (state.progress[lesson.id]?.sentences[sentence.id]?.choices.length ?? 0) > 0);
  if (stillConflicted) {
    notify('仍有句子存在双设备修改，请先在课程中选定版本');
    return;
  }
  const sentenceAttempts = buildSentenceAttempts(lesson);
  attempt.sentenceAttempts = sentenceAttempts;
  attempt.score = scoreAttempt(sentenceAttempts);
  attempt.snapshot = buildSnapshot(lesson);
  attempt.submittedAt = new Date().toISOString();
  attempt.teacherFeedback = ''; // 反馈绑定的是旧答案，重新确认后需要教师重新评价
  selectedResultSentence.value = Math.min(selectedResultSentence.value, sentenceAttempts.length - 1);
  syncSegment();
  persist();
  notify('已按当前答案重新确认，旧反馈已清空待教师重新评价');
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  if (teacherStale.value) {
    notify('该记录的答案已被改动，学生重新确认后才能写入反馈');
    return;
  }
  setTeacherFeedback(attempt.id, teacherDraft.value.trim());
  persist();
  notify('教师反馈已保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadRecords() {
  downloadText(`echo-step-records-${new Date().toISOString().slice(0, 10)}.json`, exportRecords());
  notify(`练习记录已导出（不含 ${state.attempts.length - currentAttempts().length} 条失效记录）`);
}

function downloadSyncBundle() {
  downloadText(`echo-step-drafts-${state.device.id.slice(4, 10)}-${new Date().toISOString().slice(0, 10)}.json`, exportSyncBundle());
  notify('同步包已生成，把它发给另一台设备并在那里导入');
}

function triggerSyncImport() {
  syncFileInput.value?.click();
}

function onSyncFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const report: MergeReport = importSyncBundle(String(reader.result));
      if (activeLesson.value && currentSentence.value) {
        currentAnswer.value = getSentenceDraft(activeLesson.value.id, currentSentence.value.id).value;
      }
      if (report.conflicts.length) {
        notify(`已合并 ${report.sentencesMerged} 句，其中 ${report.conflicts.length} 句两边都改过，请逐句选择`);
      } else if (report.sentencesMerged) {
        notify(`已自动接续 ${report.sentencesMerged} 句，未产生冲突`);
      } else {
        notify('同步包已导入，没有新的改动');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '同步包无法读取');
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function onConnectionChange() {
  online.value = navigator.onLine;
  persist();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') persist();
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', persist);
});

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', persist);
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>移动端语言听写</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>手机、电脑可分别离线续写同一课，回网后按句合并，两边都改的句子并列等你选择。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ currentAttempts().length }}</strong><span>有效记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 数据已保存到本机' : '● 离线模式 · 可继续已下载课程' }}</span>
          <span>本机：{{ state.device.label }}</span>
        </div>

        <section class="panel sync-panel">
          <div class="dictation-label" style="margin-top:0"><strong>多设备草稿合并</strong><span>逐句向量时钟合并</span></div>
          <p class="sync-hint">在另一台设备导出同步包，回本设备导入即可：只在一侧改过的句子自动接上；两边都改过的句子并列保留，由你选择；同一设备重复导入不会重复建冲突。</p>
          <div class="sync-actions">
            <var-button type="primary" size="small" @click="downloadSyncBundle">生成同步包</var-button>
            <var-button type="default" variant="outline" size="small" @click="triggerSyncImport">导入同步包</var-button>
          </div>
          <input ref="syncFileInput" type="file" accept="application/json,.json" hidden @change="onSyncFileChosen" />
        </section>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div><h4>{{ lesson.title }}</h4><p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟</p></div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ lesson.downloaded ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ currentAttempts().length }} 条有效 / {{ state.attempts.length }} 条总计</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top">
              <strong>{{ attempt.lessonTitle }}</strong>
              <span class="history-score">{{ attempt.score }} 分<span v-if="isAttemptStale(attempt)" class="stale-tag">已失效</span></span>
            </div>
            <p>{{ formatDate(attempt.submittedAt) }} · <template v-if="isAttemptStale(attempt)">答案已改动，重新确认前不计入统计</template><template v-else>{{ attempt.teacherFeedback || '暂无教师反馈' }}</template></p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出有效练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentSentence?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。播放速度已放慢。</p></div>
          </div>
        </section>

        <section v-if="currentDraft?.choices.length" class="conflict-card">
          <div class="dictation-label" style="margin:0 0 8px"><strong>这句两台设备都改过</strong><span>请选择保留哪个版本</span></div>
          <button v-for="(choice, index) in currentDraft.choices" :key="choice.deviceId + '-' + index" class="choice-row" @click="pickVersion(index)">
            <span class="choice-device">{{ choice.deviceLabel || '另一台设备' }} · {{ formatDate(choice.editedAt) }}</span>
            <span class="choice-text">{{ choice.value || '（空）' }}</span>
          </button>
          <p class="conflict-note">选择前提交会被阻止；你也可以直接在下方改写，视为采用本设备的新版本。</p>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>{{ currentDraft?.choices.length ? '存在待选版本' : '答案在本机自动保存' }}</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentSentence?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!(activeProgress?.sentences[sentence.id]?.value), conflict: (activeProgress?.sentences[sentence.id]?.choices.length ?? 0) > 0 }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>
        <p v-if="conflictCount" class="conflict-summary">还有 {{ conflictCount }} 句两边都改过，标红的句子需要选定版本。</p>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip" :class="{ 'status-stale': resultStale }">{{ resultStale ? '结果已失效' : `提交于 ${formatDate(resultAttempt.submittedAt)}` }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section v-if="resultStale" class="panel stale-panel">
          <strong>答案在提交后又被改动（或来自另一台设备的合并）</strong>
          <p>下面的逐词结果和教师反馈绑定的是提交当时的答案，已立即失效，重新确认前不会进入统计和导出。</p>
          <var-button block type="primary" size="small" @click="reconfirmAttempt">用当前答案重新确认</var-button>
          <var-button block type="default" variant="outline" size="small" style="margin-top:8px" @click="startLesson(activeLesson!)">返回课程修改</var-button>
        </section>

        <section class="panel result-score">
          <div class="score-ring" :class="{ dimmed: resultStale }" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击红色词可单独重听，并记录错误原因。</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">{{ resultSentence.score }}%</span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card" :class="{ 'feedback-stale': resultStale }"><strong>教师反馈{{ resultStale ? '（已失效，对应旧答案）' : '' }}</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="startLesson(activeLesson!)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>查看作答并写入反馈</p></div></div>
        </header>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ currentAttempts().length }} 条有效</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}${isAttemptStale(attempt) ? '（已失效）' : ''}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div v-if="teacherStale" class="feedback-card stale-teacher"><strong>该记录已失效</strong><p>学生在提交后改动了答案或合并了另一台设备的草稿。逐词结果与反馈均绑定旧答案，请等学生用当前答案重新确认后再写反馈。</p></div>
            <div class="feedback-card"><strong>{{ teacherAttempt.courseTitle }}</strong><p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。</p></div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" :disabled="teacherStale" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" :disabled="teacherStale" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
