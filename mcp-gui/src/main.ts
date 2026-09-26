import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { bootstrap } from "./stores/app";
import { initThemeWatcher, loadPreferences } from "./stores/preferences";

async function main(): Promise<void> {
  // 先应用偏好（语言 / 主题），避免首屏闪烁与文案跳变。
  initThemeWatcher();
  await loadPreferences();

  createApp(App).mount("#app");

  // 数据加载放到挂载之后：取数失败时界面已可见，错误条能正常显示。
  await bootstrap();
}

void main();