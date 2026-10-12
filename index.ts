// server entrypoint for opencode-quota.
//
// the plugin's work happens in the terminal: src/tui.tsx renders the footer line
// and the /use dashboard. this entry exists so the package has the same shape as
// every other opencode plugin (a main export beside ./tui), which is what lets a
// single "plugins" entry in opencode.json load the tui component automatically.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-quota",
  setup() {},
})
