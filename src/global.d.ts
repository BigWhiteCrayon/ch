import type { HostBridge, LlmBridge, OllamaBridge, SettingsBridge, SetupBridge, ThreadsBridge } from './types';

declare global {
  interface Window {
    host: HostBridge;
    llm: LlmBridge;
    threads: ThreadsBridge;
    ollamaApi: OllamaBridge;
    setupApi: SetupBridge;
    settingsApi: SettingsBridge;
  }
}

export {};
