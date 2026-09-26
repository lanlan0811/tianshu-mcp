<script setup lang="ts">
/**
 * 数据目录栏（自动探测 + 手动多目录切换 / 追加 / 移除）。
 */
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/i18n";
import {
  addDataHome,
  app,
  removeDataHome,
  setActiveDataHome,
} from "@/stores/app";

const { t } = useI18n();

const entries = computed(() => app.dataHome.entries);

async function onChange(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value;
  await setActiveDataHome(value);
}
</script>

<template>
  <div class="inline" style="gap: 6px; min-width: 0; flex: 1 1 auto">
    <AppIcon name="folder" />
    <select
      class="select"
      style="max-width: 420px"
      :value="app.dataHome.active"
      :title="app.dataHome.active"
      @change="onChange"
    >
      <option v-for="entry in entries" :key="entry.path" :value="entry.path">
        {{ entry.label || entry.path }}
      </option>
      <option v-if="entries.length === 0" value="">{{ t("dataHome.empty") }}</option>
    </select>
    <button class="btn btn-icon" :title="t('dataHome.add')" @click="addDataHome">
      <AppIcon name="folder" />
    </button>
    <button
      class="btn btn-icon"
      :title="t('dataHome.remove')"
      :disabled="entries.length <= 1"
      @click="removeDataHome(app.dataHome.active)"
    >
      <AppIcon name="close" />
    </button>
  </div>
</template>