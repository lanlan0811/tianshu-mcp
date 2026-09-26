<script setup lang="ts">
/**
 * 应用外壳：顶栏（品牌 / 数据目录 / 设置）+ 三栏（任务列表 · 内容区 · 详情）。
 */
import { ref } from "vue";
import AppIcon from "./components/AppIcon.vue";
import DataHomeBar from "./components/DataHomeBar.vue";
import TaskListPanel from "./components/TaskListPanel.vue";
import DetailPanel from "./components/DetailPanel.vue";
import EventTimeline from "./components/EventTimeline.vue";
import LogViewer from "./components/LogViewer.vue";
import ReportPanel from "./components/ReportPanel.vue";
import SearchPanel from "./components/SearchPanel.vue";
import SettingsDrawer from "./components/SettingsDrawer.vue";
import { useI18n } from "@/i18n";
import { isMockRuntime } from "@/api";
import { app, clearError, openTab, refreshTasks, type TabKey } from "@/stores/app";

const { t } = useI18n();
const settingsOpen = ref(false);

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: "events", labelKey: "tabs.events" },
  { key: "agentLogs", labelKey: "tabs.agentLogs" },
  { key: "verifyLogs", labelKey: "tabs.verifyLogs" },
  { key: "reports", labelKey: "tabs.reports" },
  { key: "serverLog", labelKey: "tabs.serverLog" },
  { key: "search", labelKey: "tabs.search" },
];
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-brand">
        <span class="brand-mark"><AppIcon name="terminal" size="14" /></span>
        <span>{{ t("app.name") }}</span>
      </div>
      <DataHomeBar />
      <span class="app-header-spacer" />
      <span v-if="isMockRuntime" class="badge tone-warn" :title="t('runtime.tauriUnavailable')">
        {{ t("runtime.mock") }}
      </span>
      <button class="btn btn-icon" :title="t('common.refresh')" @click="refreshTasks">
        <AppIcon name="refresh" />
      </button>
      <button class="btn btn-icon" :title="t('settings.title')" @click="settingsOpen = true">
        <AppIcon name="settings" />
      </button>
    </header>

    <main class="app-body">
      <TaskListPanel />

      <section class="pane">
        <header class="pane-header">
          <button
            v-for="tab in TABS"
            :key="tab.key"
            class="tab"
            :class="{ 'is-active': app.tab === tab.key }"
            @click="openTab(tab.key)"
          >
            {{ t(tab.labelKey) }}
          </button>
        </header>

        <EventTimeline v-if="app.tab === 'events'" />
        <LogViewer v-else-if="app.tab === 'agentLogs'" kind="agent" :title="t('tabs.agentLogs')" />
        <LogViewer v-else-if="app.tab === 'verifyLogs'" kind="verify" :title="t('tabs.verifyLogs')" />
        <LogViewer v-else-if="app.tab === 'serverLog'" kind="server" :title="t('tabs.serverLog')" />
        <ReportPanel v-else-if="app.tab === 'reports'" />
        <SearchPanel v-else />
      </section>

      <DetailPanel />
    </main>

    <div v-if="app.error" class="notice notice-error" style="margin: 0 16px 12px">
      <AppIcon name="alert" />
      <span style="flex: 1 1 auto">{{ app.error }}</span>
      <button class="btn btn-icon" @click="clearError"><AppIcon name="close" /></button>
    </div>

    <SettingsDrawer v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>