<script setup lang="ts">
/**
 * 设置抽屉：界面语言 / 主题 / 更新源三态 + 自动更新（检查 / 安装 / 手动下载）。
 *
 * 更新失败**不得影响主流程**：这里只展示结果与「手动下载」兜底入口。
 */
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/i18n";
import { isMockRuntime } from "@/api";
import { checkUpdate, installUpdate, probeUpdateSources, app } from "@/stores/app";
import { preferences, updatePreferences } from "@/stores/preferences";
import type { Language, ThemeMode, UpdateSource } from "@/api/types-lite";

const { t } = useI18n();

const emit = defineEmits<{ (e: "close"): void }>();

const languages: { value: Language; label: string }[] = [
  { value: "zh-CN", label: t("settings.languageZh") },
  { value: "en-US", label: t("settings.languageEn") },
];

const themes: { value: ThemeMode; label: string; icon: string }[] = [
  { value: "system", label: t("settings.themeSystem"), icon: "monitor" },
  { value: "light", label: t("settings.themeLight"), icon: "sun" },
  { value: "dark", label: t("settings.themeDark"), icon: "moon" },
];

const sources: { value: UpdateSource; label: string }[] = [
  { value: "auto", label: t("settings.sourceAuto") },
  { value: "gitee", label: t("settings.sourceGitee") },
  { value: "github", label: t("settings.sourceGithub") },
];

function probeText(side: "gitee" | "github"): string {
  const probe = app.update.probe;
  if (!probe) return t("common.notAvailable");
  const item = probe[side];
  if (!item.reachable) return t("update.unreachable");
  return t("update.reachable", { ms: item.latencyMs ?? "?" });
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <aside class="drawer">
      <header class="drawer-header">
        <AppIcon name="settings" />
        <strong>{{ t("settings.title") }}</strong>
        <span v-if="isMockRuntime" class="badge tone-warn">{{ t("runtime.mock") }}</span>
        <span class="app-header-spacer" />
        <button class="btn btn-icon" @click="emit('close')"><AppIcon name="close" /></button>
      </header>

      <div class="drawer-body">
        <div>
          <div class="field-label">{{ t("settings.language") }}</div>
          <div class="inline" style="margin-top: 6px">
            <button
              v-for="item in languages"
              :key="item.value"
              class="tab"
              :class="{ 'is-active': preferences.language === item.value }"
              @click="updatePreferences({ language: item.value })"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <div>
          <div class="field-label">{{ t("settings.theme") }}</div>
          <div class="inline" style="margin-top: 6px">
            <button
              v-for="item in themes"
              :key="item.value"
              class="tab"
              :class="{ 'is-active': preferences.theme === item.value }"
              @click="updatePreferences({ theme: item.value })"
            >
              <AppIcon :name="item.icon" /> {{ item.label }}
            </button>
          </div>
        </div>

        <div>
          <div class="field-label">{{ t("settings.updateSource") }}</div>
          <div class="inline wrap" style="margin-top: 6px">
            <button
              v-for="item in sources"
              :key="item.value"
              class="tab"
              :class="{ 'is-active': preferences.updateSource === item.value }"
              @click="updatePreferences({ updateSource: item.value })"
            >
              {{ item.label }}
            </button>
          </div>
          <div class="inline wrap" style="margin-top: 8px">
            <button class="btn btn-ghost" @click="probeUpdateSources">
              <AppIcon name="globe" />{{ t("update.probe") }}
            </button>
            <span class="hint">
              {{ t("update.probeGitee") }}: {{ probeText("gitee") }} ·
              {{ t("update.probeGithub") }}: {{ probeText("github") }}
            </span>
          </div>
          <div v-if="app.update.probe?.degraded" class="notice notice-warn" style="margin-top: 8px">
            <AppIcon name="alert" />
            <span>{{ t("update.offlineFallback") }}</span>
          </div>
        </div>

        <div class="divider" />

        <div>
          <h3 class="section-title">{{ t("update.title") }}</h3>
          <div class="hint" style="margin-bottom: 8px">
            {{ t("update.currentVersion", { v: app.update.currentVersion || "—" }) }} ·
            {{ t("update.betaChannel") }}
          </div>

          <div v-if="!app.update.updaterConfigured" class="notice notice-warn" style="margin-bottom: 8px">
            <AppIcon name="alert" />
            <span>{{ t("update.pubkeyMissing") }}</span>
          </div>

          <div class="inline wrap">
            <button
              class="btn btn-primary"
              :disabled="app.update.checking"
              @click="checkUpdate(preferences.updateSource)"
            >
              <AppIcon name="refresh" />
              {{ app.update.checking ? t("update.checking") : t("update.check") }}
            </button>
            <button
              v-if="app.update.result?.available"
              class="btn"
              :disabled="app.update.installing"
              @click="installUpdate(preferences.updateSource)"
            >
              <AppIcon name="download" />
              {{ app.update.installing ? t("update.installing") : t("update.install") }}
            </button>
            <a
              v-if="app.update.result?.manualDownloadUrl"
              class="btn"
              :href="app.update.result.manualDownloadUrl"
              target="_blank"
              rel="noreferrer noopener"
            >
              <AppIcon name="external" />{{ t("update.manualDownload") }}
            </a>
          </div>

          <div v-if="app.update.result" class="notice" style="margin-top: 10px">
            <AppIcon name="info" />
            <div>
              <div v-if="app.update.result.error" class="tone-fail">
                {{ t("update.failed", { msg: app.update.result.error }) }}
              </div>
              <div v-else-if="app.update.result.available" class="tone-ok">
                {{ t("update.available", { v: app.update.result.version ?? "" }) }}
              </div>
              <div v-else>{{ t("update.upToDate") }}</div>
              <div v-if="app.update.result.source" class="hint">
                {{ t("update.sourceUsed", { s: app.update.result.source }) }}
              </div>
              <pre v-if="app.update.result.notes" class="check-output" style="max-height: 160px">{{
                app.update.result.notes
              }}</pre>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>