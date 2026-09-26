<script setup lang="ts">
/**
 * 右栏 · 详情：任务元信息、复制、整包导出。
 */
import { computed, ref } from "vue";
import AppIcon from "./AppIcon.vue";
import StatusBadge from "./StatusBadge.vue";
import { useI18n } from "@/i18n";
import { formatDateTime } from "@/core/format";
import { taskDirRel } from "@/core/paths";
import { app, exportTaskZip, selectedTask } from "@/stores/app";

const { t } = useI18n();
const excludeHeavyLogs = ref(true);
const message = ref<string | null>(null);
const copiedKey = ref<string | null>(null);

const task = computed(() => selectedTask.value);

const taskDirAbsolute = computed(() => {
  const current = task.value;
  if (!current) return "";
  const home = app.dataHome.active.replace(/[\\/]+$/, "");
  return `${home}/${taskDirRel(current.taskId)}`;
});

async function copy(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copiedKey.value = key;
    setTimeout(() => (copiedKey.value = null), 1500);
  } catch {
    copiedKey.value = null;
  }
}

async function doExportZip(): Promise<void> {
  message.value = null;
  try {
    const path = await exportTaskZip(excludeHeavyLogs.value);
    if (path) message.value = t("export.done", { path });
  } catch (err) {
    message.value = t("export.failed", { msg: err instanceof Error ? err.message : String(err) });
  }
}
</script>

<template>
  <section class="pane">
    <header class="pane-header">
      <span class="pane-title">{{ t("detail.title") }}</span>
      <span class="app-header-spacer" />
      <button
        v-if="task"
        class="btn btn-icon"
        :title="t('common.refresh')"
        @click="copy(taskDirAbsolute, 'dir')"
      >
        <AppIcon :name="copiedKey === 'dir' ? 'check' : 'copy'" />
      </button>
    </header>

    <div class="pane-body">
      <div v-if="!task" class="empty">{{ t("detail.noSelection") }}</div>
      <template v-else>
        <div class="section" style="border-bottom: 1px solid var(--border)">
          <div class="inline" style="margin-bottom: 8px">
            <StatusBadge :status="task.status" />
            <span v-if="task.dryRun" class="badge tone-info">{{ t("tasks.dryRun") }}</span>
            <span class="app-header-spacer" />
            <button class="btn btn-ghost" @click="copy(task.taskId, 'id')">
              <AppIcon :name="copiedKey === 'id' ? 'check' : 'copy'" />
              {{ t("detail.copyTaskId") }}
            </button>
          </div>
          <div class="task-item-title" style="white-space: normal">{{ task.task || task.taskId }}</div>
        </div>

        <div class="section" style="border-bottom: 1px solid var(--border)">
          <h3 class="section-title">{{ t("detail.meta") }}</h3>
          <dl class="kv">
            <dt>{{ t("detail.taskId") }}</dt>
            <dd class="mono">{{ task.taskId }}</dd>
            <dt>{{ t("detail.agent") }}</dt>
            <dd class="mono">{{ task.agentId }}</dd>
            <dt>{{ t("detail.workspace") }}</dt>
            <dd>
              {{
                task.workspaceMode === "default"
                  ? t("workspaceMode.default")
                  : t("workspaceMode.project")
              }}
            </dd>
            <dt>{{ t("detail.project") }}</dt>
            <dd class="mono">{{ task.displayPath || task.projectPath || t("common.none") }}</dd>
            <dt>{{ t("detail.rounds") }}</dt>
            <dd>{{ task.roundsUsed }}</dd>
            <dt>{{ t("detail.reportRound") }}</dt>
            <dd>{{ task.reportRound ?? t("common.notAvailable") }}</dd>
            <dt>{{ t("detail.createdAt") }}</dt>
            <dd>{{ formatDateTime(task.createdAt) }}</dd>
            <dt>{{ t("detail.updatedAt") }}</dt>
            <dd>{{ formatDateTime(task.updatedAt) }}</dd>
            <dt>{{ t("detail.finishedAt") }}</dt>
            <dd>{{ formatDateTime(task.finishedAt) }}</dd>
            <dt>{{ t("detail.errorType") }}</dt>
            <dd>{{ task.errorType ?? t("common.none") }}</dd>
            <dt>{{ t("detail.lastMessage") }}</dt>
            <dd>{{ task.lastMessage ?? t("common.none") }}</dd>
            <dt>{{ t("detail.checkSummary") }}</dt>
            <dd>{{ task.checkSummary || t("common.none") }}</dd>
            <dt>{{ t("detail.diffstat") }}</dt>
            <dd class="mono">{{ task.diffstat || t("common.none") }}</dd>
          </dl>
        </div>

        <div class="section" style="border-bottom: 1px solid var(--border)">
          <h3 class="section-title">{{ t("detail.changedFiles") }}</h3>
          <div v-if="task.changedFiles.length === 0" class="hint">{{ t("common.none") }}</div>
          <div v-for="file in task.changedFiles" :key="file" class="mono truncate" :title="file">
            {{ file }}
          </div>
        </div>

        <div class="section">
          <h3 class="section-title">{{ t("export.exportTaskZip") }}</h3>
          <label class="inline" style="gap: 4px; margin-bottom: 8px">
            <input v-model="excludeHeavyLogs" type="checkbox" />
            <span class="hint">{{ t("export.excludeHeavyLogs") }}</span>
          </label>
          <button class="btn" @click="doExportZip">
            <AppIcon name="archive" />{{ t("export.exportTaskZip") }}
          </button>
          <div v-if="message" class="hint" style="margin-top: 6px">{{ message }}</div>
        </div>
      </template>
    </div>
  </section>
</template>