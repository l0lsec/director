// The same one-minute timing gate with the small English model that is installed on this Mac.
process.env.DIRECTOR_SPEED_MODEL = 'small.en';
const mod = await import('./l4.1-speed.mjs');
export default mod.default;
