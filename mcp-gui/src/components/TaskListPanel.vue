<script setup lang="ts">
/**
 * 左栏：任务列表（筛选 / 排序 / 状态色标 / 轮次）。
 */
import { computed, ref } from "vue";
import AppIcon from "./AppIcon.vue";
import StatusBadge from "./StatusBadge.vue";
import { useI18n } from "@/i18n";
import { countByPhase, emptyFilter } from "@/core/filter";
import { formatDateTime } from "@/core/format";
import { refreshTasks, selectTask, app, taskFacets, visibleTasks } from "@/stores/app";
import type { SortDir, SortKey } from "@/api/types";

const { t } = useI18n();
const showFilters = ref(true);

const counts = computed(() => countByPhase(app.tasks));
const facets = computed(() => taskFacets.value);

function isoFromDate(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const d = new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const fromDate = computed({
  get: () => (app.filter.from ? app.filter.from.slice(0, 10) : ""),
  set: (v: string) => {
    app.filter.from = isoFromDate(v, false);
    void refreshTasks();
  },
});

const toDate = computed({
  get: () => (app.filter.to ? app.filter.to.slice(0, 10) : ""),
  set: (v: string) => {
    app.filter.to = isoFromDate(v, true);
    void refreshTasks();
  },
});

async function onFilterChange(): Promise<void> {
  await refreshTasks();
}

async function resetFilters(): Promise<void> {
  Object.assign(app.filter, emptyFilter());
  await refreshTasks();
}

async function onSortChange(key: SortKey, dir: SortDir): Promise<void> {
  app.sortKey = key;
  app.sortDir = dir;
  await refreshTasks();
}
</script>

<template>
  <section class="pane">
    <header class="pane-header">
      <span class="pane-title">{{ t("tasks.title") }}</span>
      <span class="hint">{{ t("tasks.count", { n: app.tasks.length }) }}</span>
      <span class="hint tone-active">{{ t("tasks.activeCount", { n: counts.active }) }}</span>
      <span class="hint">{{ t("tasks.terminalCount", { n: counts.terminal }) }}</span>
      <span class="app-header-spacer" />
      <button class="btn btn-icon" :title="t('common.refresh')" @click="refreshTasks">
        <AppIcon name="refresh" />
      </button>
      <button class="btn btn-icon" :title="t('tasks.filterKeyword')" @click="showFilters = !showFilters">
        <AppIcon :name="showFilters ? 'chevronUp' : 'chevronDown'" />
      </button>
    </header>

    <div v-if="showFilters" class="section" style="border-bottom: 1px solid var(--border)">
      <div class="field">
        <input
          v-model="app.filter.keyword"
          class="input"
          :placeholder="t('tasks.filterKeyword')"
          @keyup.enter="onFilterChange"
          @change="onFilterChange"
        />
      </div>
      <div class="grid-2" style="margin-top: 8px">
        <div class="field">
          <span class="field-label">{{ t("tasks.filterAgent") }}</span>
          <select v-model="app.filter.agentId" class="select" @change="onFilterChange">
            <option :value="null">{{ t("common.all") }}</option>
            <option v-for="a in facets.agents" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>
        <div class="field">
          <span class="field-label">{{ t("tasks.filterStatus") }}</span>
          <select v-model="app.filter.status" class="select" @change="onFilterChange">
            <option :value="null">{{ t("common.all") }}</option>
            <option v-for="s in facets.statuses" :key="s" :value="s">{{ t(`status.${s}`) }}</option>
          </select>
        </div>
      </div>
      <div class="field" style="margin-top: 8px">
        <span class="field-label">{{ t("tasks.filterProject") }}</span>
        <select v-model="app.filter.projectPath" class="select" @change="onFilterChange">
          <option :value="null">{{ t("common.all") }}</option>
          <option v-for="p in facets.projects" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
      <div class="grid-2" style="margin-top: 8px">
        <div class="field">
          <span class="field-label">{{ t("tasks.filterFrom") }}</span>
          <input v-model="fromDate" class="input" type="date" />
        </div>
        <div class="field">
          <span class="field-label">{{ t("tasks.filterTo") }}</span>
          <input v-model="toDate" class="input" type="date" />
        </div>
      </div>
      <div class="inline wrap" style="margin-top: 8px">
        <label class="inline" style="gap: 4px">
          <input v-model="app.filter.onlyActive" type="checkbox" @change="onFilterChange" />
          <span class="hint">{{ t("tasks.onlyActive") }}</span>
        </label>
        <span class="app-header-spacer" />
        <select
          class="select"
          style="max-width: 130px"
          :value="app.sortKey"
          @change="onSortChange(($event.target as HTMLSelectElement).value as SortKey, app.sortDir)"
        >
          <option value="updatedAt">{{ t("tasks.sortUpdatedAt") }}</option>
          <option value="createdAt">{{ t("tasks.sortCreatedAt") }}</option>
          <option value="taskId">{{ t("tasks.sortTaskId") }}</option>
        </select>
        <button
          class="btn btn-icon"
          :title="app.sortDir === 'desc' ? t('tasks.sortDesc') : t('tasks.sortAsc')"
          @click="onSortChange(app.sortKey, app.sortDir === 'desc' ? 'asc' : 'desc')"
        >
          <AppIcon :name="app.sortDir === 'desc' ? 'chevronDown' : 'chevronUp'" />
        </button>
        <button class="btn btn-ghost" @click="resetFilters">{{ t("tasks.resetFilter") }}</button>
      </div>
    </div>

    <div class="pane-body">
      <div v-if="app.tasksLoading" class="empty">{{ t("common.loading") }}</div>
      <div v-else-if="visibleTasks.length === 0" class="empty">
        <div>{{ t("tasks.noTasks") }}</div>
        <div class="hint" style="margin-top: 4px">{{ t("tasks.noTasksHint") }}</div>
      </div>
      <div v-else>
        <div
          v-for="task in visibleTasks"
          :key="task.taskId"
          class="task-item"
          :class="{ 'is-selected': task.taskId === app.selectedTaskId }"
          @click="selectTask(task.taskId)"
        >
          <div class="task-item-top">
            <StatusBadge :status="task.status" />
            <span v-if="task.dryRun" class="badge tone-info">{{ t("tasks.dryRun") }}</span>
            <span class="app-header-spacer" />
            <span class="hint mono">{{ task.agentId }}</span>
          </div>
          <div class="task-item-title" :title="task.task">{{ task.task || task.taskId }}</div>
          <div class="task-item-meta">
            <span class="mono truncate" :title="task.taskId">{{ task.taskId }}</span>
          </div>
          <div class="task-item-meta">
            <span>{{ formatDateTime(task.updatedAt) }}</span>
            <span>{{ t("tasks.rounds", { used: task.roundsUsed }) }}</span>
            <span v-if="task.reportRound !== null">
              {{ t("tasks.reportRound", { n: task.reportRound }) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>