/** Agent access to the same organization operations used by the UI. No enable/disable controls. */
export function createPacksTool(operations) {
  return {
    name: "plugin_packs",
    description: "Read plugin-pack tags and single-level folders, classify locally, or organize folders. Organization never changes plugin enablement. list may save automatic tags for newly installed user bundles. Returns the v2 state and storage paths.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "auto-tag", "group-create", "group-add", "group-remove", "group-rename", "group-dissolve"],
          description: "list reads state; auto-tag reclassifies current user bundles while respecting manual and suppressed tags; group actions organize folders." },
        id: { type: "string", description: "Existing folder ID from list; required for group-add/remove/rename/dissolve." },
        name: { type: "string", description: "Folder name, 1–120 characters; required for group-create/rename." },
        members: { type: "array", items: { type: "string" }, description: "Nonempty unique package names for group-create/add/remove. Create/add accepts existing manageable user or optional official bundles and moves them out of any previous folder." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      return args?.action === "list" ? operations.list() : operations.act(args);
    },
  };
}
