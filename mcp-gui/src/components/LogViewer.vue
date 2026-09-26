<script setup lang="ts">
/**
 * 中栏 · 原始日志查看器（agent-<round>.log / verify-<round>.log / logs/server.log）。
 *
 * 大文件策略：首屏只读尾部窗口，向前按块加载；跟随开关关闭时**不把视口强行拉回底部**。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/i18n";
import { startWatch } from "@/api/watch";
import { highlightSegments, LOG_LEVELS, parseLogText, filterLogLines, type LogLevel } from "@/core/logline";
import { formatBytes } from "@/core/format";
import { logLevelTone } from "@/core/status";
import {
  app,
  applyLogGrowth,
  exportCurrentFile,
  loadMoreLog,
  openLog,
  openRoundLog,
  selectedTask,
} from "@/stores/app";

const props = defineProps<{
  kind: "agent" | "verify" | "server";
  title: string;
}>();

const { t } = useI18n();
const scroller = ref<HTMLElement | null>(null);
const copied = ref(false);
const exportMessage = ref<string | null>(null);

const rounds = computed<number[]>(() => {
  const task = selectedTask.value;
  if (!task) return [];
  return props.kind === "agent" ? task.artifacts.agentLogs : task.artifacts.verifyLogs;
});

const activeRound = computed<number | null>(() => {
  const m = new RegExp(`/${props.kind}-(\\d+)\\.log$`).exec(app.logRelPath);
  return m ? Number(m[1]) : null;
});

const isServerLog = computed(() => props.kind === "server");

const parsedLines = computed(() => parseLogText(app.logText));
const visibleLines = computed(() => filterLogLines(parsedLines.value, app.logFilter));

const hasMoreBefore = computed(() => (app.logChunk?.loadedFrom ?? 0) > 0);

function levelLabel(level: LogLevel): string {
  const map: Record<LogLevel, string> = {
    debug: t("logs.levelDebug"),
    info: t("logs.levelInfo"),
    warn: t("logs.levelWarn"),
    error: t("logs.levelError"),
    unknown: t("logs.levelUnknown"),
  };
  return map[level];
}

function toggleLevel(level: LogLevel): void {
  const set = new Set(app.logFilter.levels);
  if (set.has(level)) set.delete(level);
  else set.add(level);
  app.logFilter.levels = [...set];
}

async function openRound(round: number): Promise<void> {
  if (props.kind === "server") return;
  await openRoundLog(props.kind, round);
}

let stopWatch: (() => void) | null = null;

async function restartWatch(): Promise<void> {
  stopWatch?.();
  stopWatch = null;
  if (!app.logRelPath || !app.logFollow) return;
  stopWatch = await startWatch([app.logRelPath], (payload) => {
    void applyLogGrowth(payload.totalBytes);
  });
}

onBeforeUnmount(() => stopWatch?.());

watch(
  () => [app.logRelPath, app.logFollow] as const,
  () => {
    void restartWatch();
  },
  { immediate: true },
);

watch(
  () => app.logText,
  async () => {
    if (!app.logFollow) return;
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (!nearBottom && app.logFollow) app.logFollow = false;
  else if (nearBottom && !app.logFollow) app.logFollow = true;
}

async function jumpToLatest(): Promise<void> {
  app.logFollow = true;
  await openLog(app.logRelPath);
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function copyAll(): Promise<void> {
  try {
    await navigator.clipboard.writeText(app.logText);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

async function doExport(): Promise<void> {
  exportMessage.value = null;
  try {
    const path = await exportCurrentFile();
    if (path) exportMessage.value = t("export.done", { path });
  } catch (err) {
    exportMessage.value = t("export.failed", { msg: err instanceof Error ? err.message : String(err) });
  }
}
</script>

<template>
  <div class="pane-inner">
    <header class="pane-header">
      <span class="pane-title">{{ props.title }}</span>
      <template v-if="!isServerLog">
        <button
          v-for="r in rounds"
          :key="r"
          class="tab"
          :class="{ 'is-active': r === activeRound }"
          @click="openRound(r)"
        >
          {{ t("logs.round", { n: r }) }}
        </button>
        <span v-if="rounds.length === 0" class="hint">{{ t("common.none") }}</span>
      </template>
      <span class="app-header-spacer" />
      <span class="hint">
        {{
          t("logs.loadedOf", {
            loaded: formatBytes(app.logChunk ? app.logChunk.loadedTo - app.logChunk.loadedFrom : 0),
            total: formatBytes(app.logChunk?.totalBytes ?? 0),
          })
        }}
      </span>
      <button class="btn" :disabled="!hasMoreBefore || app.logLoading" @click="loadMoreLog">
        <AppIcon name="chevronUp" />{{ t("logs.loadMore") }}
      </button>
      <button class="btn" :class="{ 'btn-primary': app.logFollow }" @click="jumpToLatest">
        <AppIcon name="arrowDown" />{{ t("logs.jumpToLatest") }}
      </button>
      <button class="btn btn-icon" :title="t('common.copy')" @click="copyAll">
        <AppIcon :name="copied ? 'check' : 'copy'" />
      </button>
      <button class="btn btn-icon" :title="t('export.exportFile')" @click="doExport">
        <AppIcon name="download" />
      </button>
    </header>

    <div class="section" style="border-bottom: 1px solid var(--border)">
      <div class="inline wrap">
        <template v-if="isServerLog">
          <button
            v-for="level in LOG_LEVELS"
            :key="level"
            class="tab"
            :class="{ 'is-active': app.logFilter.levels.includes(level) }"
            @click="toggleLevel(level)"
          >
            <span :class="`tone-${logLevelTone(level)}`">{{ levelLabel(level) }}</span>
          </button>
        </template>
        <input
          v-model="app.logFilter.keyword"
          class="input"
          style="max-width: 240px"
          :placeholder="t('logs.keyword')"
        />
        <label class="inline" style="gap: 4px">
          <input v-model="app.logShowLineNumbers" type="checkbox" />
          <span class="hint">{{ t("logs.lineNumbers") }}</span>
        </label>
        <label class="inline" style="gap: 4px">
          <input v-model="app.logWrap" type="checkbox" />
          <span class="hint">{{ t("logs.wrap") }}</span>
        </label>
        <span class="app-header-spacer" />
        <span class="hint">
          {{ t("logs.filteredHint", { shown: visibleLines.length, total: parsedLines.length }) }}
        </span>
      </div>
      <div v-if="exportMessage" class="hint" style="margin-top: 6px">{{ exportMessage }}</div>
    </div>

    <div
      ref="scroller"
      class="pane-body log-view"
      :class="{ 'is-wrap': app.logWrap }"
      @scroll="onScroll"
    >
      <div v-if="app.logLoading" class="empty">{{ t("common.loading") }}</div>
      <div v-else-if="parsedLines.length === 0" class="empty">{{ t("logs.empty") }}</div>
      <div v-else-if="visibleLines.length === 0" class="empty">{{ t("search.noResults") }}</div>
      <template v-else>
        <div v-for="line in visibleLines" :key="line.line" class="log-row">
          <span v-if="app.logShowLineNumbers" class="log-gutter">{{ line.line }}</span>
          <span class="log-text">
            <template v-for="(seg, i) in highlightSegments(line.raw, app.logFilter.keyword)" :key="i">
              <mark v-if="seg.hit">{{ seg.text }}</mark>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </div>
      </template>
    </div>

    <footer class="pane-footer">
      <span v-if="app.logFollow" class="tone-ok">{{ t("logs.following") }}</span>
      <span v-else>{{ t("logs.paused") }}</span>
      <span v-if="hasMoreBefore" class="hint" style="margin-left: 8px">{{ t("logs.loadMore") }}…</span>
    </footer>
  </div>
</template>