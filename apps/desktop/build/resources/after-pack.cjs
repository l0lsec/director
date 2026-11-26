// Remove Electron's sample app, which the unpacked Electron distribution carries.
const { rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
exports.default = async function afterPack(context) {
  const res = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'default_app.asar');
  if (existsSync(res)) rmSync(res);
};
