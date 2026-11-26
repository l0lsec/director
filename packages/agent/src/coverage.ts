/**
 * What an agent uses for each thing the person can do in the app. Tests fail when the app gains a
 * command or the engine gains an edit operation that is not listed here, so agent control cannot
 * silently fall behind the UI.
 */

export type Coverage = { tool: string; note?: string } | { uiOnly: string };

/** Every engine edit command (exported `*Ops` functions) and the tool that reaches it. */
export const ENGINE_COVERAGE: Record<string, string> = {
  splitOps: 'split', splitAllAtOps: 'split', liftRangeOps: 'delete_range', rippleDeleteRangeOps: 'delete_range', rippleDeleteRangesOps: 'delete_range',
  deleteClipsOps: 'delete_clips', moveClipOps: 'move_clip', trimOps: 'trim_clip', slipOps: 'slip_clip', rollOps: 'roll_edit',
  insertClipOps: 'add_clip', setSpeedOps: 'set_speed', detachAudioOps: 'detach_audio', duplicateClipOps: 'duplicate_clip',
  setRampOps: 'set_speed', freezeFrameOps: 'freeze_frame', reverseOps: 'set_clip', pipOps: 'set_layout', speakerLayoutOps: 'speaker_layout', applyTemplateOps: 'apply_template',
  applyOps: 'apply_ops', parseOps: 'apply_ops', takeToOps: 'add_take',
};

/** Every primitive op in the project format and a named tool that produces it (apply_ops reaches all of them too). */
export const PRIMITIVE_COVERAGE: Record<string, string> = {
  addMedia: 'import_media', removeMedia: 'apply_ops', updateMedia: 'apply_ops', addLane: 'add_lane', removeLane: 'remove_lane', updateLane: 'update_lane',
  moveLane: 'move_lane', addClip: 'add_clip', removeClip: 'delete_clips', updateClip: 'set_clip', moveClipToLane: 'move_clip', addMarker: 'add_marker',
  removeMarker: 'remove_marker', updateMarker: 'update_marker', setCanvas: 'set_canvas', setMeta: 'set_project',
};

const RIPPLE = 'ripple is an argument of each edit tool (default true for deletes and trims)';

/** Every command in the app's command palette. */
export const COMMAND_COVERAGE: Record<string, Coverage> = {
  'edit.play': { tool: 'play', note: 'pause stops it' },
  'edit.split': { tool: 'split' },
  'edit.delete': { tool: 'delete_clips' },
  'edit.lift': { tool: 'delete_clips', note: 'ripple:false' },
  'edit.undo': { tool: 'undo' },
  'edit.redo': { tool: 'redo' },
  'edit.selectAll': { tool: 'select_clips' },
  'edit.duplicate': { tool: 'duplicate_clip' },
  'edit.trimStart': { tool: 'trim_clip', note: 'edge:"start"' },
  'edit.trimEnd': { tool: 'trim_clip', note: 'edge:"end"' },
  'edit.nudgeLeft': { tool: 'move_clip', note: 'by: -one frame' },
  'edit.nudgeRight': { tool: 'move_clip', note: 'by: one frame' },
  'edit.detach': { tool: 'detach_audio' },
  'edit.marker': { tool: 'add_marker' },
  'edit.text': { tool: 'add_text' },
  'edit.toolSelect': { uiOnly: 'Mouse pointer mode; agents act on clips by id' },
  'edit.toolBlade': { tool: 'split', note: 'the blade is a mouse mode for split' },
  'edit.toolSlip': { tool: 'slip_clip' },
  'edit.toolRoll': { tool: 'roll_edit' },
  'edit.snap': { tool: 'set_project', note: 'snapping' },
  'edit.ripple': { tool: 'trim_clip', note: RIPPLE },
  'edit.zoomIn': { uiOnly: 'Timeline view zoom; agents see the edit with render_contact_sheet' },
  'edit.zoomOut': { uiOnly: 'Timeline view zoom; agents see the edit with render_contact_sheet' },
  'edit.zoomFit': { uiOnly: 'Timeline view zoom; agents see the edit with render_contact_sheet' },
  'edit.prevEdit': { tool: 'seek', note: 'edit points come from get_timeline' },
  'edit.nextEdit': { tool: 'seek', note: 'edit points come from get_timeline' },
  'edit.frameBack': { tool: 'seek' },
  'edit.frameForward': { tool: 'seek' },
  'edit.start': { tool: 'seek', note: 't:0' },
  'edit.end': { tool: 'seek', note: 't: durationSec' },
  'edit.shuttleBack': { tool: 'seek' },
  'edit.shuttleStop': { tool: 'pause' },
  'edit.shuttleForward': { tool: 'play' },
  'edit.inPoint': { tool: 'delete_range', note: 'agents pass from/to directly instead of marking in and out' },
  'edit.outPoint': { tool: 'delete_range', note: 'agents pass from/to directly instead of marking in and out' },
  'edit.deleteInOut': { tool: 'delete_range' },
  'edit.loop': { uiOnly: 'Playback looping is a viewing preference' },
  'edit.save': { tool: 'save_project' },
  'edit.director': { tool: 'propose_edits', note: 'the in-app Director is itself an agent; external agents use every tool' },
  'assistant.open': { uiOnly: 'opens the in-app assistant chat, which is itself an agent driving these same tools' },
  'edit.freeze': { tool: 'freeze_frame' },
  'edit.reverse': { tool: 'set_clip', note: 'reverse:true' },
  'edit.speakerLayout': { tool: 'speaker_layout' },
  'edit.makeReel': { tool: 'make_reel' },
  'project.new': { tool: 'create_project' },
  'project.open': { tool: 'open_project' },
  'record.start': { uiOnly: 'Recording needs the person in front of the camera; agents edit takes once they are recorded' },
  'record.stop': { uiOnly: 'Recording needs the person in front of the camera' },
  'record.prompter': { uiOnly: 'The teleprompter is for the person recording' },
  'record.prompterClose': { uiOnly: 'The teleprompter is for the person recording' },
  'record.follow': { uiOnly: 'Teleprompter scrolling mode' },
  'record.wpm': { uiOnly: 'Teleprompter scrolling mode' },
  'script.new': { uiOnly: 'Scripts are written in the Script workspace; agents read them with list_scripts and get_script and attach them with attach_script' },
  'script.draft': { uiOnly: 'In-app Claude drafting; an external agent writes its own drafts and reads scripts with get_script' },
  'script.hooks': { uiOnly: 'In-app Claude hook writing; agents read scripts with get_script' },
  'settings.open': { uiOnly: 'Agents cannot open or change their own permissions' },
  'swipe.import': { uiOnly: 'The person curates their reference library; agents read it with list_references and get_reference' },
  'go.swipe': { tool: 'show_workspace' }, 'go.script': { tool: 'show_workspace' }, 'go.record': { tool: 'show_workspace' }, 'go.edit': { tool: 'show_workspace' }, 'go.export': { tool: 'show_workspace' },
};
