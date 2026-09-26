<script setup lang="ts">
/**
 * 中栏 · 验收报告：Markdown 渲染 / 结构化卡片 / 视觉验收（sandbox）/ dry-run 分区 / 多轮对比。
 */
import { computed, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import ReportCard from "./ReportCard.vue";
import { useI18n } from "@/i18n";
import { api } from "@/api";
import { summarizeReport, type ReportSummary } from "@/core/report";
import { renderMarkdown } from "@/core/markdown";
import { buildSandboxHtml } from "@/core/sandbox";
import { app, openReport, selectedTask, setError, type ReportKind } from "@/stores/app";

const { t } = useI18n();

const REGULAR_KINDS: ReportKind[] = ["md", "json", "html"];
const DRY_RUN_KINDS: ReportKind[] = ["dry-run-md", "dry-run-json"];

const summaries = ref<Record<string, ReportSummary | null>>({});
const leftSummary = ref<ReportSummary | null>(null);
const rightSummary = ref<ReportSummary | null>(null);

const task = computed(() => selectedTask.value);
const rounds = computed<number[]>(() => {
  const a = task.value?.artifacts;
  if (!a) return [];
  return app.reportKind.startsWith("dry-run") ? a.dryRunMd : a.reportMd;
});

const availableKinds = computed<ReportKind[]>(() => {
  const a = task.value?.artifacts;
  const out: ReportKind[] = [];
  if (a) {
    if (a.reportMd.length > 0) out.push("md");
    if (a.reportJson.length > 0) out.push("json");
    if (a.reportHtml.length > 0) out.push("html");
    if (a.dryRunMd.length > 0) out.push("dry-run-md");
    if (a.dryRunJson.length > 0) out.push("dry-run-json");
  }
  return out.length > 0 ? out : [...REGULAR_KINDS, ...DRY_RUN_KINDS];
});

function kindLabel(kind: ReportKind): string {
  switch (kind) {
    case "md":
      return t("reports.markdown");
    case "json":
      return t("reports.structured");
    case "html":
      return t("reports.visual");
    case "dry-run-md":
      return `${t("reports.dryRun")} · MD`;
    case "dry-run-json":
      return `${t("reports.dryRun")} · JSON`;
    default:
      return kind;
  }
}

const renderedMarkdown = computed(() =>
  app.reportKind === "md" || app.reportKind === "dry-run-md"
    ? renderMarkdown(app.reportText)
    : "",
);

const sandboxHtml = computed(() =>
  app.reportKind === "html" ? buildSandboxHtml(app.reportText) : "",
);

const jsonSummary = computed<ReportSummary | null>(() => {
  const key = `${app.reportKind}:${app.reportRound}`;
  return summaries.value[key] ?? null;
});

async function loadJsonSummary(kind: ReportKind, round: number): Promise<void> {
  const current = task.value;
  if (!current) return;
  const key = `${kind}:${round}`;
  if (summaries.value[key] !== undefined) return;
  try {
    const res = await api.readReport({
      dataHome: app.dataHome.active,
      taskId: current.taskId,
      round,
      kind: kind === "dry-run-json" ? "dry-run-json" : "json",
    });
    summaries.value[key] = res.missing ? null : summarizeReport(JSON.parse(res.text));
  } catch (err) {
    summaries.value[key] = null;
    setError(err);
  }
}

watch(
  () => [app.reportKind, app.reportRound, task.value?.taskId] as const,
  () => {
    if (app.reportKind === "json" || app.reportKind === "dry-run-json") {
      void loadJsonSummary(app.reportKind, app.reportRound);
    }
    if (app.compareOn) void loadCompare();
    if (task.value && !availableKinds.value.includes(app.reportKind)) {
      void openReport(rounds.value[rounds.value.length - 1] ?? 0, availableKinds.value[0] ?? "md");
    }
  },
  { immediate: true },
);

async function loadCompare(): Promise<void> {
  const current = task.value;
  if (!current) return;
  const list = current.artifacts.reportJson;
  if (list.length === 0) return;
  const left = app.compareLeftRound || (list[0] ?? 0);
  const right = app.compareRightRound || (list[list.length - 1] ?? 0);
  app.compareLeftRound = left;
  app.compareRightRound = right;
  const load = async (round: number): Promise<ReportSummary | null> => {
    try {
      const res = await api.readReport({
        dataHome: app.dataHome.active,
        taskId: current.taskId,
        round,
        kind: "json",
      });
      return res.missing ? null : summarizeReport(JSON.parse(res.text));
    } catch {
      return null;
    }
  };
  leftSummary.value = await load(left);
  rightSummary.value = await load(right);
}

function toggleCompare(): void {
  app.compareOn = !app.compareOn;
  if (app.compareOn) {
    const list = task.value?.artifacts.reportJson ?? [];
    app.compareLeftRound = list[0] ?? 0;
    app.compareRightRound = list[list.length - 1] ?? 0;
    void loadCompare();
  }
}
</script>

<template>
  <div class="pane-inner">
    <header class="pane-header">
      <span class="pane-title">{{ t("reports.title") }}</span>
      <div class="report-tabs">
        <button
          v-for="kind in availableKinds"
          :key="kind"
          class="tab"
          :class="{ 'is-active': kind === app.reportKind }"
          @click="openReport(rounds[rounds.length - 1] ?? 0, kind)"
        >
          {{ kindLabel(kind) }}
        </button>
      </div>
      <span class="app-header-spacer" />
      <button
        v-for="r in rounds"
        :key="r"
        class="tab"
        :class="{ 'is-active': r === app.reportRound && !app.compareOn }"
        @click="openReport(r, app.reportKind)"
      >
        {{ t("reports.round", { n: r }) }}
      </button>
      <button class="btn" :class="{ 'btn-primary': app.compareOn }" @click="toggleCompare">
        <AppIcon name="compare" />{{ t("reports.compare") }}
      </button>
    </header>

    <div class="pane-body">
      <div v-if="!task" class="empty">{{ t("detail.noSelection") }}</div>

      <template v-else-if="app.compareOn">
        <div class="section">
          <div class="inline">
            <span class="hint">{{ t("reports.compareHint") }}</span>
            <span class="app-header-spacer" />
            <select v-model.number="app.compareLeftRound" class="select" style="max-width: 120px" @change="loadCompare">
              <option v-for="r in task.artifacts.reportJson" :key="`l-${r}`" :value="r">
                {{ t("reports.left") }} {{ t("reports.round", { n: r }) }}
              </option>
            </select>
            <select v-model.number="app.compareRightRound" class="select" style="max-width: 120px" @change="loadCompare">
              <option v-for="r in task.artifacts.reportJson" :key="`r-${r}`" :value="r">
                {{ t("reports.right") }} {{ t("reports.round", { n: r }) }}
              </option>
            </select>
          </div>
        </div>
        <div class="grid-2" style="align-items: start; padding: 0 12px 12px">
          <div class="md" style="padding: 0">
            <ReportCard
              v-if="leftSummary"
              :summary="leftSummary"
              :title="`${t('reports.left')} · ${t('reports.round', { n: app.compareLeftRound })}`"
            />
            <div v-else class="empty">{{ t("reports.missing") }}</div>
          </div>
          <div class="md" style="padding: 0">
            <ReportCard
              v-if="rightSummary"
              :summary="rightSummary"
              :title="`${t('reports.right')} · ${t('reports.round', { n: app.compareRightRound })}`"
            />
            <div v-else class="empty">{{ t("reports.missing") }}</div>
          </div>
        </div>
      </template>

      <div v-else-if="app.reportLoading" class="empty">{{ t("common.loading") }}</div>
      <div v-else-if="app.reportMissing" class="empty">{{ t("reports.missing") }}</div>

      <div v-else-if="app.reportKind === 'md' || app.reportKind === 'dry-run-md'" class="md" v-html="renderedMarkdown" />

      <template v-else-if="app.reportKind === 'json' || app.reportKind === 'dry-run-json'">
        <ReportCard v-if="jsonSummary" :summary="jsonSummary" />
        <div v-else class="empty">{{ t("reports.missing") }}</div>
      </template>

      <div v-else-if="app.reportKind === 'html'" style="height: 100%; padding: 12px">
        <div class="hint" style="margin-bottom: 6px">{{ t("reports.htmlSandboxHint") }}</div>
        <iframe
          class="sandbox-frame"
          sandbox=""
          referrerpolicy="no-referrer"
          :srcdoc="sandboxHtml"
        />
      </div>
    </div>
  </div>
</template>