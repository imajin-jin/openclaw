import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setImajinRuntime,
  clearRuntime: clearStoredImajinRuntime,
  getRuntime: getImajinRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "imajin",
  errorMessage: "Imajin runtime not initialized",
});

export { getImajinRuntime, setImajinRuntime };

export function clearImajinRuntime() {
  clearStoredImajinRuntime();
}
