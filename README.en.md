# dsh-plugin-packs · Plugin Packs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4C9AFF.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![version](https://img.shields.io/badge/version-v0.3.1-success.svg)](../../releases)
[![JavaScript](https://img.shields.io/badge/JavaScript-ESM-f7df1e.svg)](lib/client.js)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7B68EE.svg)](https://github.com/topics/dsh-plugin)

[中文](README.md) | **English**

> Arrange the plugin packs installed in DeepSeek Harness (`dsh`) into **two columns, Minecraft
> resource-pack style**: on the left the ones **running together**, on the right the ones **installed
> but switched off**. Each pack can carry tags, and the tag bar narrows the list in one click.

<img src="icon.svg" alt="Plugin Packs icon" width="96">

![Two-column Plugin Packs view: enabled packs on the left, switched-off packs on the right, tags on each card, tag bar on top](https://raw.githubusercontent.com/mmmmlp-cloud/dsh-plugin-packs/main/docs/images/packs-overview.png)

*UI preview (sample data): four packs running together on the left, four installed but switched off on the right.*

## What it solves

Once you have dozens of plugins, the question stops being "what is this plugin called" and becomes
**"what am I actually running right now"**. The built-in Plugins page is one flat installed list with
enabled and disabled packs mixed together, so you have to remember which is which.

This plugin re-arranges the same data into two columns, which turns "what is on" into something you
can see at a glance; on top of that it adds custom tags (writing / search / UI / security / models …)
so a list of dozens is two clicks away from the pack you want.

**How it differs from folder/group plugins:**

| | This plugin | Folders / group plugins |
|---|---|---|
| Main view | **Enabled vs disabled** (global two columns) | A hierarchy you define yourself |
| Where data lives | A **`packs.json` file** (follows `DSH_HOME`) | Usually browser `localStorage` |
| New browser / cleared site data | tags and display names survive | groups are usually lost |
| Hand-editable / versionable | yes | usually not |
| Relationship | orthogonal, can coexist | — |

In one line: folders answer "which category does it belong to", the two columns answer "is it on right
now". This plugin does the latter, and uses tags for the former.

## Install

```powershell
# From npm (recommended)
dsh plugin --profile web add dsh-plugin-packs

# The official CLI can also install straight from GitHub
dsh plugin --profile web add github:mmmmlp-cloud/dsh-plugin-packs

# Or from a local checkout
git clone https://github.com/mmmmlp-cloud/dsh-plugin-packs.git
dsh plugin --profile web add ./dsh-plugin-packs
```

Restart `dsh web` once after installing (the host half mounts an HTTP route), then press `Ctrl+F5`.

Entry point: **left sidebar → 「插件」(Plugins) → tab 「插件包」(Packs)**, next to the built-in
「已安装」(Installed) tab. (dsh has two surfaces both called "plugins": the sidebar page and
Settings → Plugins. This plugin lives on the **sidebar page**.)

## Using it

- **Two columns**: left "Enabled · in use", right "Disabled". Square cards, two per row in each column.
- **Move a pack**: click the `→` / `←` arrow, or drag the card straight into the other column.
- **Batch**: tick several cards and enable/disable them together.
- **Tags**: a pack can carry several; click a tag in the bar to filter, click again to clear.
  "Untagged" surfaces packs you have not classified yet.
- **Search** matches display name, package name, description, version and tags.
- **Scope**: Mine (default) / Official / All; tick "show system core" to reveal the read-only group.
- **Details**: expand a card for the full description, source, and the pack's plugin rows with their
  running state — plus rename and tag editing. An expanded card spans the full row.
- **Feedback**: every switch reports its real outcome — applied / needs a dsh restart / overridden by a
  higher layer / failed, with the error code. Applied changes offer **Undo**, which also runs preflight.
- **Remembers the tab**: once you pick 「插件包」, switching away and back in the same session stays there.

## Health and risk checks (0.2.0)

Open the tab or choose **Check all** to read a fresh inventory. Cards distinguish loaded, problem, risk, unverified and disabled. Only `fiberPhase=active` counts as running. Details show evidence, impact, suggestions and coverage; use **Problems / risks only** to filter.

Checks cover missing packages, explicit compatibility errors, exact entryId runtime rows and declared configuration overrides. A disabled row does not imply a broken package, while all rows disabled cannot prove successful loading. An override is a risk, not a proven conflict; similar names, shared modules or shared slots are not conflict evidence.

Arrows, drag/drop, batches and Undo share preflight. Risks are reviewed together and checked again when continuing. Explicit missing/version/platform problems block enabling. A batch stops at the first result that is not applied. No automatic fixes, trial activation, credential reads, plugin function calls or inventory uploads. External programs, key validity, full dependency graphs and compatibility without an explicit error remain unverified.

Read-only endpoints: `GET /plugin-packs/api/diagnostics` and `POST /plugin-packs/api/preflight` with `{changes:[{name,enabled}]}` and an `x-plugin-packs` header. Neither reads nor writes tag files.

## Automatic tags and groups (0.3.0)

- **Auto-classify** adds local rule-based labels to existing profile-installed packs. Newly installed packs are classified when the page reads state. Rules inspect names, descriptions and localized metadata only: no model calls, network or default catch-all labels.
- Manual tags remain intact. Dismissed automatic labels are remembered across refresh and repeated classification; deleted categories are not recreated.
- Drop a pack onto another card's grouping area to create a folder-like group, or into an existing group to move it there. Selecting packs offers a keyboard-friendly alternative. Groups are single-level, with one group per pack.
- Groups share the original plugin columns: any enabled member places a group on the left; fully disabled or empty groups sit on the right. Mixed groups explicitly show partial enablement. The name input is always visible, even while collapsed; save with the button or Enter. Drag only the group icon across columns to run whole-group preflight, without interfering with name editing. Members are not duplicated in the loose columns. Search matches group names and members; expanding retains member details and independent switches.
- Grouping, renaming, removing members and dissolving never change enablement or uninstall packages. Missing members remain recoverable and removable. Dissolving requires a second click.
- Group switches target **all members**, including those hidden by filters. Confirmation reloads membership and reruns preflight; changed findings require review again. Missing/system members must be removed first, not silently skipped. Batches stop at the first non-applied result; they are not transactions and do not auto-roll back.
- State v2 stores revision, groups, automatic tags and dismissal intent. Migration keeps `packs.json.v1.bak`; atomic backup publication requires same-directory hard-link support and safely refuses migration when unavailable. Revision checks reject stale writes; the queue coordinates this process only, not external editors or other processes. `POST /plugin-packs/api/state/actions` and the `plugin_packs` agent tool share metadata operations; neither provides risk approval or implicit enablement.

## Data

Tags and display names live in one plain JSON file:

```
<$DSH_HOME>/plugin-packs/packs.json        # default: C:\Users\<you>\.dsh\plugin-packs\packs.json
```

```json
{
  "version": 2,
  "revision": 1,
  "groups": [],
  "tags": [{ "id": "novel", "label": "Novel · Reading", "color": "#7B68EE" }],
  "packs": {
    "dsh-novel-writer": { "name": "Novel writing assistant", "tags": ["novel"] }
  }
}
```

- Keys are **package names** (not entry ids), so tags survive reinstalls, upgrades and id changes.
- A missing file is seeded with an empty pack map plus 7 **generic category tags** (Novel · Reading,
  Search, UI, Security, Models, Memory, Tools). Local rules suggest categories and you can edit them —
  **no packs are pre-filled**, because what someone installs is their private business and a management
  tool should not print "what the author used" into its source (a stranger's machine would not have
  those packs anyway).
- **Hand-editable** — save and refresh. A malformed file is never silently discarded: it is backed up
  (`packs.json.broken-<unique id>`) before rebuilding. Backup failure prevents overwriting the original.
- Writes are atomic (temp file + rename) and serialized, so rapid tagging cannot lose updates.

It only touches plugin-pack metadata — never sessions, prompts or credentials.

## Which layer it changes

"Enable / disable" calls the kernel's `pluginManager.setBundleEnabled`, i.e. it **adds or removes the
pack from the profile's bundle selection layer**:

- dependencies stay in `node_modules`; you can always move the pack back — this is **not** an uninstall;
- it changes real plugin state, not just what this page shows;
- packs managed by a higher configuration layer are marked read-only instead of pretending they work.

Toggling **individual loader rows inside a pack** is out of scope here (that is what row-level plugin
managers do); the row list on this page is read-only.

## Scope and read-only group

| Scope | Contents |
|---|---|
| Mine (default) | `availability === "profile"` — the packs you installed |
| Official | optional `@deepseek-ai/dsh-experimental-*` bundles shipped with dsh |
| All | both of the above |
| Show system core | read-only group: `dsh-base` / `dsh-web-app`, plus the **acp / headless / sdk-app / sdk-minimal** bundles, which belong to other run modes. Never toggleable, so a stray click cannot break the desktop profile |

Missing catalog-only candidates are hidden; missing selected or installed packages stay visible for diagnosis.

## Architecture

One package, two halves, zero runtime dependencies, no build step:

```
dsh-plugin-packs/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # inserts one plugin-packs row (purely additive)
├── lib/index.js          # host half: same-origin data routes
├── lib/client.js         # browser half: the two-column UI (React, plain ESM)
├── locale/{zh,en}.json   # name and description shown in the plugins list
├── icon.svg
└── scripts/render-check.mjs   # offline render self-test (no browser needed)
```

All data goes through the host half's same-origin routes; the browser half never touches a remote
namespace:

| Method | Path | Purpose |
|---|---|---|
| GET | `/plugin-packs/api/health` | self-check: `build` marker, route, data file path |
| GET | `/plugin-packs/api/bundles` | pack list + row state + same-snapshot report (`{ bundles, plugins, diagnostics }`) |
| POST | `/plugin-packs/api/bundles/enabled` | whole-pack toggle, body `{ name, enabled }`, returns the official `ChangeResult`; requires `x-plugin-packs: 1` |
| GET | `/plugin-packs/api/state` | read the tag document (seeded when absent) |
| PUT | `/plugin-packs/api/state` | replace it wholesale; requires `x-plugin-packs: 1` |

> Why not call `ctx.remote.pluginManager` from the browser: that layer depends on the client remote
> assembly order and can fail silently during startup (the tab simply disappears, with no error).
> A host route can be verified with `curl` alone and does not care about assembly order. Write calls
> require a custom header — a cross-origin page cannot set one without a preflight, and this route
> answers no preflight, so another local page cannot use it to change your plugin state.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No 「插件包」 tab | It lives on the **sidebar Plugins page**, not in Settings → Plugins. Also check that `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json` still lists `dsh-plugin-packs` — a deselected bundle takes the whole row (and its browser half) with it. Re-select it, then `Ctrl+F5` |
| `HTTP 404 / response is not JSON` | The host half is not mounted. Run `curl 127.0.0.1:<port>/plugin-packs/api/health` and look for the `build` field |
| Host code change not taking effect | Follow the installation result: replacing a loaded host module can require restarting DSH; toggling alone does not guarantee a fresh module. Verify the `build` field |
| Switch reports "restart required" | That pack needs a `dsh web` restart to fully apply; the message says so |
| Page behaviour did not change | Browser-half plugins fully unload only after a page refresh (`Ctrl+F5`); the host half applies immediately |

## Development

```powershell
npm test                                              # state/health/tool and offline interaction tests
node scripts/render-check.mjs                          # offline structure/behavior checks, not visual validation
node scripts/render-check.mjs --profile <profile dir>  # borrow react/react-dom from that profile
node --check lib/client.js && node --check lib/index.js
```

`render-check.mjs` renders the component with a hook-only mock React and covers eight scenarios:
default two columns, search, tag filter, system group, official scope, error state, expanded details,
loading — so UI changes report real failures without a browser.

## Known limits

1. Pack level only; use a row-level plugin manager for individual plugin rows.
2. Tags are local files, not synced to a dsh account; copy `packs.json` to move machines.
3. The built-in "Installed" tab cannot be replaced (its content is rendered by the page itself, not
   contributed through a slot); this plugin sits beside it as a second view.
4. Coexists fine with similar plugins (`dsh-plugins-folders` groups, `dsh-plugin-namecards` display
   names) — they write different data.

## License

[MIT](LICENSE) © mmmmlp-cloud

Built on DeepSeek Harness's public plugin mechanism; not affiliated with DeepSeek.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
