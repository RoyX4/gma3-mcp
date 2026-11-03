/**
 * SU-10: tool discovery (SETUP.md SU-10). The server instructions the client shows the model at connect time, and
 * the pointer to the structured tools in the gma3_lua / gma3_command descriptions.
 *
 * Field evidence: on a stale build an agent did all show work in Lua; in the field test an agent wrote a Lua waiting
 * loop to watch a chase, hit the 5 s Lua budget, and never found gma3_observe_tempo. Every tool named here must be
 * registered (test/discovery.test.ts checks it against the running server).
 */

/** Setup and show tasks, each with the tools that do it (the first one is usually the one to start with). */
export const TASK_TOOLS: ReadonlyArray<{ task: string; tools: readonly string[] }> = [
  { task: "connection health/identity", tools: ["gma3_connection_check", "gma3_reconnect"] },
  { task: "context and writer coordination", tools: ["gma3_fast_context", "gma3_writer_lease", "gma3_batch", "gma3_programmer_snapshot"] },
  { task: "native cue values and tracking", tools: ["gma3_native_cue_data", "gma3_compile_tracking", "gma3_explain_tracking_cue", "gma3_compare_tracking_cues", "gma3_lint_tracking"] },
  { task: "durable programming and resume", tools: ["gma3_programming_job", "gma3_show_checkpoint"] },
  { task: "calibrated focus", tools: ["gma3_focus_target"] },
  { task: "fixture colour", tools: ["gma3_set_fixture_color"] },
  { task: "MVR revisions/export", tools: ["gma3_inspect_mvr", "gma3_compare_mvr", "gma3_mvr_import_plan", "gma3_apply_mvr_positions", "gma3_export_mvr"] },
  { task: "cameras/2D Layouts", tools: ["gma3_cameras", "gma3_configure_camera", "gma3_bind_camera_view", "gma3_build_layout"] },
  { task: "appearances/screen windows (Lua opt-in)", tools: ["gma3_configure_appearance", "gma3_build_workspace"] },
  { task: "fixture type library", tools: ["gma3_patch_library", "gma3_patch_import", "gma3_patch_library_add", "gma3_patch_types", "gma3_patch_remove_type"] },
  { task: "patch fixtures", tools: ["gma3_patch_add", "gma3_patch_set", "gma3_patch_remove", "gma3_patch_list", "gma3_patch_move", "gma3_patch_retype"] },
  { task: "fixture modes/cells", tools: ["gma3_patch_type_structure"] },
  { task: "3D placement", tools: ["gma3_place_fixtures", "gma3_fixture_positions"] },
  { task: "cell layouts", tools: ["gma3_layout_cells", "gma3_assign_cell_layout"] },
  { task: "programmer looks", tools: ["gma3_select", "gma3_set_attributes", "gma3_set_color", "gma3_set_position", "gma3_set_attribute", "gma3_clear_programmer"] },
  { task: "presets", tools: ["gma3_apply_preset", "gma3_store_preset", "gma3_preset", "gma3_release_attributes"] },
  { task: "groups/MAtricks", tools: ["gma3_store_group", "gma3_selection_grid", "gma3_configure_matricks", "gma3_matricks"] },
  { task: "phasers", tools: ["gma3_build_phaser", "gma3_phaser_release"] },
  { task: "cues", tools: ["gma3_cue_settings", "gma3_configure_cue", "gma3_store_cues", "gma3_edit_cues", "gma3_store_cue", "gma3_set_cue_timing", "gma3_set_cue_trigger", "gma3_cue_contents", "gma3_delete_cue"] },
  { task: "chases", tools: ["gma3_build_chase"] },
  { task: "executors/playback", tools: ["gma3_assign_to_executor", "gma3_configure_executor", "gma3_configure_sequence", "gma3_playback", "gma3_goto_cue", "gma3_set_fader"] },
  { task: "speed masters", tools: ["gma3_configure_speed_master", "gma3_speed_master_action", "gma3_speed_masters"] },
  { task: "recipes", tools: ["gma3_recipes", "gma3_edit_recipe", "gma3_edit_recipe_steps", "gma3_cook_recipes"] },
  { task: "macros/dialogs", tools: ["gma3_store_macro", "gma3_edit_macro_line", "gma3_run_macro", "gma3_macros", "gma3_dialog"] },
  { task: "variables", tools: ["gma3_variables", "gma3_set_variable"] },
  { task: "tags", tools: ["gma3_tags", "gma3_assign_tag", "gma3_store_tag", "gma3_delete_tag", "gma3_configure_tag", "gma3_playback"] },
  { task: "timecode", tools: ["gma3_build_timecode", "gma3_timecode_transport", "gma3_timecodes", "gma3_build_fader_timecode", "gma3_timecode_record", "gma3_record_fader_curve"] },
  { task: "DMX/output diagnosis", tools: ["gma3_diagnose_fixture", "gma3_dmx_output", "gma3_configure_dmx_output", "gma3_dmx", "gma3_fixture_output"] },
  { task: "OSC", tools: ["gma3_osc", "gma3_configure_osc", "gma3_test_osc_input"] },
  { task: "show files", tools: ["gma3_save_show", "gma3_show_files"] },
  { task: "Views/ViewButtons", tools: ["gma3_views", "gma3_view_contents", "gma3_store_view", "gma3_recall_view", "gma3_assign_view_button"] },
  { task: "tempo sync", tools: ["gma3_tempo_sync_status", "gma3_configure_tempo_sync", "gma3_playback"] },
  { task: "show inspection", tools: ["gma3_objects", "gma3_get_object", "gma3_list_children", "gma3_programmer", "gma3_fixture_attributes", "gma3_cues", "gma3_sequences"] },
];

/** Tools that watch the console over time on the server side: no Lua loop, no Lua time budget. */
export const OBSERVING_TOOLS: ReadonlyArray<{ tool: string; what: string }> = [
  { tool: "gma3_observe_tempo", what: "how fast running sequences (chases) advance" },
  { tool: "gma3_observe_values", what: "programmer or DMX output values of fixtures as they change" },
  { tool: "gma3_build_chase", what: "one cycle of the chase it built" },
  { tool: "gma3_run_macro", what: "a macro's running line" },
  { tool: "gma3_timecode_transport", what: "a timecode show's cursor and the sequences it fires" },
];

/** Tools with a batch form (SU-12): one call with a list, each item with the single form's checks and read-back. */
export const BATCH_TOOLS: ReadonlyArray<{ tool: string; list: string }> = [
  { tool: "gma3_store_group", list: "groups" },
  { tool: "gma3_store_preset", list: "presets, each from explicit content" },
  { tool: "gma3_store_macro", list: "macros" },
  { tool: "gma3_edit_macro_line", list: "edits" },
  { tool: "gma3_assign_to_executor", list: "assignments" },
  { tool: "gma3_configure_sequence", list: "sequences, with ranges" },
  { tool: "gma3_set_variable", list: "variables" },
  { tool: "gma3_store_cues", list: "sequences" },
  { tool: "gma3_store_tag", list: "tags" },
  { tool: "gma3_delete_tag", list: "tags" },
  { tool: "gma3_assign_tag", list: "assignments" },
  { tool: "gma3_configure_tag", list: "tags" },
];

const BATCH_NOTE = `Many objects at once: ${BATCH_TOOLS.map((b) => `${b.tool} (${b.list})`).join(", ")} take lists with per-item checks and read-back; never loop over them in Lua.`;

const OBSERVE_NOTE = `Watching over time: ${OBSERVING_TOOLS.map((o) => `${o.tool} (${o.what})`).join(", ")}. They sample on the server side; never write a Lua waiting or polling loop (each gma3_lua request is limited to about 5 s).`;

/** The server instructions: sent on every start; a stale build's warning comes first. */
export function serverInstructions(staleWarning?: string): string {
  const map = TASK_TOOLS.map((t) => `- ${t.task}: ${t.tools.join(", ")}`).join("\n");
  return [
    ...(staleWarning ? [staleWarning, ""] : []),
    "gma3-mcp controls grandMA3. Structured tools check, act once and read back. Map from task to tools:",
    map,
    BATCH_NOTE,
    OBSERVE_NOTE,
    "Fallbacks, only for what no structured tool covers: gma3_command (one command line; gma3_help has the syntax) and gma3_lua (off by default; short scripts only). gma3_status shows the bridge version and the build.",
  ].join("\n");
}

/** The pointer at the start of gma3_lua's description. */
export const LUA_FALLBACK_NOTE =
  "FALLBACK: use a structured tool when one fits; they check, read back and need no Lua. Patch: gma3_patch_library, gma3_patch_import, gma3_patch_add, gma3_patch_set, gma3_patch_move, gma3_patch_retype, gma3_patch_type_structure, gma3_place_fixtures, gma3_layout_cells. Dialogs: gma3_dialog (never Mouse()). " +
  "Groups: gma3_store_group, gma3_configure_matricks. Presets: gma3_apply_preset, gma3_store_preset. Phasers: gma3_build_phaser. Looks: gma3_set_attributes. Cues: gma3_store_cues, gma3_edit_cues, gma3_build_chase, gma3_cue_contents. " +
  "Playback: gma3_configure_sequence, gma3_configure_executor, gma3_playback, gma3_goto_cue. Reads: gma3_objects, gma3_get_object, gma3_list_children, gma3_programmer. " +
  `${BATCH_NOTE} ` +
  `${OBSERVE_NOTE} `;

/** The pointer at the start of gma3_command's description. */
export const COMMAND_FALLBACK_NOTE =
  "FALLBACK for a command no structured tool covers: patching, looks, presets, groups, phasers, cues, chases and playback have their own tools (see the server instructions), which check before acting and read back; a raw command is not checked or read back. ";
