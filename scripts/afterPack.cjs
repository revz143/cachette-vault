const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const { rcedit } = await import("rcedit");
  const projectDir = context.packager.projectDir;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(projectDir, "assets", "icon.ico");
  const version = context.packager.appInfo.version;

  await rcedit(exePath, {
    "version-string": {
      FileDescription: "Cachette Vault",
      ProductName: "Cachette Vault",
      InternalName: "Cachette Vault",
      OriginalFilename: "Cachette Vault.exe"
    },
    "file-version": version,
    "product-version": version,
    icon: iconPath
  });
};
