<script setup lang="ts">
/**
 * 中栏 · 跨任务全局搜索（按需扫描，不建本地全文索引；有进度与可取消）。
 */
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/i18n";
import { taskIdFromRel } from "@/core/paths";
import {
  app,
  cancelSearch,
  loadEvents,
  openLog,
  openReport,
  runSearch,
  selectTask,
} from "@/stores/app";
import type { SearchHit } from "@/api/types";

const { t } = useI18n();

const canRun = computed(
  () => app.search.keyword.trim().length > 0 && Object.values(app.search.scope).some(Boolean),
);

const groups = computed(() => app.search.result?.groups ?? []);

async function doSearch(): Promise<void> {
  if (!canRun.value) return;
  await runSearch();
}

async function jumpTo(hit: SearchHit): Promise<void> {
  const rel = hit.relPath;
  const taskId = taskIdFromRel(rel);
  if (taskId && taskId !== app.selectedTaskId) {
    await selectTask(taskId);
  }
  if (/task\.jsonl$/.test(rel)) {
    app.tab = "events";
    await loadEvents(true);
    return;
  }
  if (/agent-\d+\.log$/.test(rel)) {
    app.tab = "agentLogs";
    await openLog(rel);
    return;
  }
  if (/verify-\d+\.log$/.test(rel)) {
    app.tab = "verifyLogs";
    await openLog(rel);
    return;
  }
  if (/dry-run-report-(\d+)\.(md|json)$/.test(rel)) {
    const round = Number(/dry-run-report-(\d+)\./.exec(rel)?.[1] ?? 0);
    app.tab = "reports";
    await openReport(round, rel.endsWith(".md") ? "dry-run-md" : "dry-run-json");
    return;
  }
  if (/report-(\d+)\.(md|json|html)$/.test(rel)) {
    const round = Number(/report-(\d+)\./.exec(rel)?.[1] ?? 0);
    app.tab = "reports";
    await openReport(round, rel.endsWith(".md") ? "md" : rel.endsWith(".json") ? "json" : "html");
    return;
  }
  app.tab = "serverLog";
  await openLog(rel);
}
</script>

<template>
  <div class="pane-inner">
    <header class="pane-header">
      <span class="pane-title">{{ t("search.title") }}</span>
      <span class="app-header-spacer" />
      <span v-if="app.search.running" class="hint">{{ t("search.progress", { n: app.search.scanned }) }}</span>
      <span v-else-if="app.search.result" class="hint">
        {{ t("search.scanned", { n: app.search.result.scannedFiles }) }} ·
        {{ t("search.results", { n: app.search.result.totalHits }) }}
      </span>
    </header>

    <div class="section" style="border-bottom: 1px solid var(--border)">
      <div class="inline">
        <input
          v-model="app.search.keyword"
          class="input"
          :placeholder="t('search.placeholder')"
          @keyup.enter="doSearch"
        />
        <button class="btn btn-primary" :disabled="!canRun || app.search.running" @click="doSearch">
          <AppIcon name="search" />{{ t("search.run") }}
        </button>
        <button class="btn" :disabled="!app.search.running" @click="cancelSearch">
          <AppIcon name="close" />{{ t("search.cancel") }}
        </button>
      </div>
      <div class="inline wrap" style="margin-top: 8px">
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.caseSensitive" type="checkbox" />
          <span class="hint">{{ t("search.caseSensitive") }}</span>
        </label>
        <span class="hint">{{ t("search.scope") }}:</span>
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.scope.eventStream" type="checkbox" />
          <span class="hint">{{ t("search.scopeEvents") }}</span>
        </label>
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.scope.agentLogs" type="checkbox" />
          <span class="hint">{{ t("search.scopeAgentLogs") }}</span>
        </label>
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.scope.verifyLogs" type="checkbox" />
          <span class="hint">{{ t("search.scopeVerifyLogs") }}</span>
        </label>
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.scope.reports" type="checkbox" />
          <span class="hint">{{ t("search.scopeReports") }}</span>
        </label>
        <label class="inline" style="gap: 4px">
          <input v-model="app.search.scope.serverLog" type="checkbox" />
          <span class="hint">{{ t("search.scopeServerLog") }}</span>
        </label>
      </div>
      <div v-if="!canRun" class="hint" style="margin-top: 6px">
        {{ app.search.keyword.trim().length === 0 ? t("search.needKeyword") : t("search.needScope") }}
      </div>
    </div>

    <div class="pane-body">
      <div v-if="app.search.running" class="empty">{{ t("search.progress", { n: app.search.scanned }) }}</div>
      <div v-else-if="!app.search.result" class="empty">{{ t("search.placeholder") }}</div>
      <div v-else-if="groups.length === 0" class="empty">{{ t("search.noResults") }}</div>
      <template v-else>
        <div v-for="group in groups" :key="group.relPath">
          <div class="search-group-title">
            {{ group.relPath }}
            <span class="hint" style="margin-left: 8px">
              {{ t("search.results", { n: group.hits.length }) }}
            </span>
          </div>
          <div
            v-for="hit in group.hits"
            :key="`${hit.relPath}:${hit.line}`"
            class="search-hit"
            @click="jumpTo(hit)"
          >
            <div class="inline">
              <span class="hint mono">{{ hit.line }}</span>
              <span class="app-header-spacer" />
              <span class="hint">{{ t("search.jump") }} <AppIcon name="chevronRight" size="12" /></span>
            </div>
            <div class="search-snippet">{{ hit.snippet }}</div>
          </div>
          <div v-if="group.truncated" class="hint" style="padding: 4px 16px">
            {{ t("search.truncated", { n: group.hits.length }) }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>