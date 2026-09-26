<script setup lang="ts">
/** 结构化报告卡片（`report-<round>.json` / `dry-run-report-<round>.json`）。 */
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/i18n";
import { formatDuration } from "@/core/format";
import type { ReportSummary } from "@/core/report";

const props = defineProps<{ summary: ReportSummary; title?: string }>();
const { t } = useI18n();
</script>

<template>
  <div class="section">
    <div class="inline" style="margin-bottom: 8px">
      <span class="section-title" style="margin: 0">{{ props.title ?? t("reports.structured") }}</span>
      <span
        v-if="props.summary.round !== null"
        class="badge tone-muted"
      >{{ t("reports.round", { n: props.summary.round }) }}</span>
      <span
        class="badge"
        :class="props.summary.passed ? 'tone-ok' : 'tone-fail'"
      >
        <AppIcon :name="props.summary.passed ? 'check' : 'close'" size="12" />
        {{ props.summary.verdict ?? (props.summary.passed ? t("reports.passed") : t("reports.failed")) }}
      </span>
      <span class="app-header-spacer" />
      <span class="hint">
        {{
          t("reports.summary", {
            passed: props.summary.counts.passed,
            failed: props.summary.counts.failed,
            skipped: props.summary.counts.skipped,
          })
        }}
      </span>
    </div>

    <div v-if="props.summary.message" class="notice" style="margin-bottom: 8px">
      <AppIcon name="info" />
      <span>{{ props.summary.message }}</span>
    </div>

    <div v-if="props.summary.checks.length > 0" style="margin-bottom: 12px">
      <div class="hint" style="margin-bottom: 4px">{{ t("reports.checks") }}</div>
      <div
        v-for="check in props.summary.checks"
        :key="check.name"
        class="check-row"
        :class="{ 'is-failed': !check.passed && !check.skipped }"
      >
        <span :class="check.passed ? 'tone-ok' : check.skipped ? 'tone-muted' : 'tone-fail'">
          <AppIcon :name="check.passed ? 'check' : check.skipped ? 'pause' : 'close'" size="14" />
        </span>
        <span class="truncate" :title="check.name">
          {{ check.name }}
          <span v-if="check.optional" class="hint">({{ t("reports.optional") }})</span>
        </span>
        <span class="mono truncate" :title="check.cmd">{{ check.cmd }}</span>
        <span class="hint">{{ formatDuration(check.durationMs) }}</span>
        <span class="hint mono">{{ check.exitCode ?? t("common.notAvailable") }}</span>
        <pre v-if="check.outputTail" class="check-output">{{ check.outputTail }}</pre>
      </div>
    </div>

    <div v-if="props.summary.diffstat.totalAdd + props.summary.diffstat.totalDel > 0" style="margin-bottom: 12px">
      <div class="hint" style="margin-bottom: 4px">
        {{ t("reports.diffstat") }} ·
        <span class="tone-ok">{{ t("reports.addLines", { n: props.summary.diffstat.totalAdd }) }}</span>
        <span class="tone-fail">{{ t("reports.delLines", { n: props.summary.diffstat.totalDel }) }}</span>
      </div>
      <table class="md" style="padding: 0">
        <tbody>
          <tr v-for="file in props.summary.diffstat.perFile" :key="file.file">
            <td class="mono">{{ file.file }}</td>
            <td style="width: 80px" class="tone-ok">{{ file.binary ? "bin" : `+${file.add}` }}</td>
            <td style="width: 80px" class="tone-fail">{{ file.binary ? "bin" : `-${file.del}` }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="kv" style="margin-bottom: 8px">
      <dt>{{ t("reports.changedFiles") }}</dt>
      <dd>{{ props.summary.changedFiles.length > 0 ? props.summary.changedFiles.join(", ") : t("common.none") }}</dd>
      <dt>{{ t("reports.untrackedFiles") }}</dt>
      <dd>
        {{ props.summary.untrackedFiles.length > 0 ? props.summary.untrackedFiles.join(", ") : t("common.none") }}
      </dd>
      <dt>{{ t("reports.signals") }}</dt>
      <dd class="mono">
        {{
          Object.entries(props.summary.signals)
            .map(([k, v]) => `${k}=${v}`)
            .join(" / ") || t("common.none")
        }}
      </dd>
    </div>

    <div v-if="props.summary.blockingIssues.length > 0" class="notice notice-error" style="margin-bottom: 8px">
      <AppIcon name="alert" />
      <div>
        <div>{{ t("reports.blockingIssues") }}</div>
        <div v-for="issue in props.summary.blockingIssues" :key="issue.code" class="mono">
          {{ issue.code }}: {{ issue.message }}
        </div>
      </div>
    </div>

    <div v-if="props.summary.warnings.length > 0" class="notice notice-warn" style="margin-bottom: 8px">
      <AppIcon name="alert" />
      <div>
        <div>{{ t("reports.warnings") }}</div>
        <div v-for="(w, i) in props.summary.warnings" :key="i">{{ w }}</div>
      </div>
    </div>

    <div v-if="props.summary.notes.length > 0" class="notice" style="margin-bottom: 8px">
      <AppIcon name="info" />
      <div>
        <div>{{ t("reports.notes") }}</div>
        <div v-for="(n, i) in props.summary.notes" :key="i">{{ n }}</div>
      </div>
    </div>

    <div v-if="props.summary.dryRunReason" class="hint">
      {{ t("reports.dryRun") }} · {{ props.summary.dryRunReason }}
    </div>
  </div>
</template>