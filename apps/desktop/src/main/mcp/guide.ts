/** MCP resources and prompts: the same catalog, presented the way MCP clients (Claude Desktop) surface them. */

export const RESOURCES = [
  { uri: 'director://guide', name: 'Getting started', description: 'What is open, the permission mode, units, a professional workflow and every tool by group', mimeType: 'application/json', tool: 'get_started', args: {} },
  { uri: 'director://timeline', name: 'Timeline', description: 'The open project with every clip in full detail', mimeType: 'application/json', tool: 'get_timeline', args: { detail: 'full' } },
  { uri: 'director://transcript', name: 'Transcript', description: 'What is said, word by word with times and indices', mimeType: 'application/json', tool: 'get_transcript', args: {} },
  { uri: 'director://capabilities', name: 'Capabilities', description: 'Effects with parameter ranges, transitions, animations, caption styles and presets', mimeType: 'application/json', tool: 'get_capabilities', args: {} },
  { uri: 'director://media', name: 'Media', description: 'Imported media in the project bin', mimeType: 'application/json', tool: 'list_media', args: {} },
] as const;

type Args = Record<string, string | undefined>;
const tail = 'Work in Director through its tools only. Read before you edit, preview risky edits with dryRun, group related edits with batch, and check the result with render_contact_sheet. Tell me what you changed and why.';

export const PROMPTS: Array<{ name: string; title: string; description: string; arguments: Array<{ name: string; description: string; required?: boolean }>; text: (a: Args) => string }> = [
  {
    name: 'edit_reel', title: 'Edit this into a reel', description: 'Turn the open recording into a tight, captioned short-form reel',
    arguments: [{ name: 'goal', description: 'What the reel should achieve or feel like' }, { name: 'length', description: 'Target length in seconds' }],
    text: (a) => `Edit the open Director project into a short-form reel${a.goal ? ` that ${a.goal}` : ''}${a.length ? `, about ${a.length} seconds long` : ''}. Call get_started, get_timeline and get_transcript. Transcribe if needed. Make a rough cut (auto_cut, cut_words for flubs and repeats), hook in the first 2 seconds, punch-in zooms on key lines, captions in a bold style, music under the voice with ducking, and a clear call to action at the end. ${tail}`,
  },
  {
    name: 'tighten_pacing', title: 'Tighten the pacing', description: 'Remove dead air, fillers and repeats, and keep the energy up',
    arguments: [{ name: 'referenceId', description: 'Optional Swipe reference id to match' }],
    text: (a) => `Tighten the pacing of the open Director project. Measure it with analyze_pacing${a.referenceId ? ` against reference ${a.referenceId}` : ''}, then remove pauses and filler words (auto_cut with dryRun first), cut repeated or weak lines (cut_words), and add visual changes (zoom effects, b-roll placeholders) where a shot runs longer than about 3 seconds. Report the pacing before and after. ${tail}`,
  },
  {
    name: 'caption_and_title', title: 'Captions and titles', description: 'Add captions and on-screen titles that match a style',
    arguments: [{ name: 'style', description: 'Caption style: word-pop, karaoke, boxed, clean or bold-yellow' }],
    text: (a) => `Add captions to the open Director project with generate_captions${a.style ? ` in the ${a.style} style` : ''} and adjust them with style_captions so they sit clear of the platform interface. Add a hook title over the first seconds and a call-to-action title at the end with add_text, animated in and out. ${tail}`,
  },
  {
    name: 'color_and_sound', title: 'Color and sound pass', description: 'Grade every shot consistently and mix the audio',
    arguments: [{ name: 'look', description: 'The look you want, e.g. warm and punchy' }],
    text: (a) => `Do a color and sound pass on the open Director project. Look at frames with render_contact_sheet, grade one shot${a.look ? ` toward a ${a.look} look` : ''} with add_effect color (and vignette if it helps), then copy_effects to matching shots. Clean the voice with process_audio, set music around -16 dB with duckUnderVoice and fades, and make sure nothing clips. ${tail}`,
  },
  {
    name: 'match_reference', title: 'Match a reference reel', description: 'Edit toward the pacing and structure of a Swipe reference',
    arguments: [{ name: 'referenceId', description: 'Swipe reference id from list_references', required: true }],
    text: (a) => `Edit the open Director project to follow reference ${a.referenceId ?? '(ask me which)'}: read it with get_reference, compare with analyze_pacing, and shape the edit to match its hook, structure (hook, setup, payoff, call to action) and cut rhythm, while keeping my words. ${tail}`,
  },
];
