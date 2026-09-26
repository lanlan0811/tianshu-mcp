/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GUI_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Tauri 2 在注入运行时后会挂载该内部对象 */
interface Window {
  __TAURI_INTERNALS__?: unknown;
}