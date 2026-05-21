const { join } = require('node:path');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const frameworks = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks');
  const helpers = [
    ['Chrodis Helper.app', 'Chrodis Helper'],
    ['Chrodis Helper (GPU).app', 'Chrodis Helper (GPU)'],
    ['Chrodis Helper (Plugin).app', 'Chrodis Helper (Plugin)'],
    ['Chrodis Helper (Renderer).app', 'Chrodis Helper (Renderer)']
  ];
  for (const [bundle, name] of helpers) {
    const plistPath = join(frameworks, bundle, 'Contents', 'Info.plist');
    if (!existsSync(plistPath)) continue;
    const plist = readFileSync(plistPath, 'utf8')
      .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${name}$2`)
      .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${name}$2`);
    writeFileSync(plistPath, plist);
  }
};
