// Drift-only form of the sync gate (absolute offset under fake devices is device skew; see leaf-1.1 ABANDON G2).
process.env.DIRECTOR_SYNC_DRIFT_ONLY = '1';
const mod = await import('./l1.1-sync.mjs');
export default mod.default;
