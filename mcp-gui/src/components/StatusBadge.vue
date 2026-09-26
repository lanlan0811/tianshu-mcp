<script setup lang="ts">
/** 任务状态徽标（色标由 core/status.ts 统一给出）。 */
import { computed } from "vue";
import { useI18n } from "@/i18n";
import { statusTone } from "@/core/status";

const props = withDefaults(defineProps<{ status: string; dot?: boolean }>(), { dot: true });
const { t } = useI18n();

const tone = computed(() => statusTone(props.status));
const label = computed(() => {
  const text = t(`status.${props.status}`);
  return text.startsWith("status.") ? props.status : text;
});
</script>

<template>
  <span class="badge" :class="`tone-${tone}`">
    <span v-if="props.dot" class="dot" />
    {{ label }}
  </span>
</template>