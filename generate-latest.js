#!/usr/bin/env bun

/**
 * Generates latest.json for Tauri auto-updater
 * Run after `bun tauri build` to create update manifest
 */

const tauriConfText = await Bun.file("src-tauri/tauri.conf.json").text();
const { version } = JSON.parse(tauriConfText);

const baseUrl = `https://github.com/SibXoDev/stuzhik/releases/download/v${version}`;
const baseBuildPath = "src-tauri/target/release/bundle/";

const platforms = {};

// Windows x64 (NSIS installer)
const winFile = `${baseBuildPath}nsis/stuzhik_${version}_x64-setup.exe`;
if (await Bun.file(winFile).exists()) {
  const sigPath = `${winFile}.sig`;
  const signature = await Bun.file(sigPath).exists()
    ? (await Bun.file(sigPath).text()).trim()
    : undefined;

  platforms["windows-x86_64"] = {
    url: `${baseUrl}/stuzhik_${version}_x64-setup.exe`,
    signature,
  };
  console.log("  Windows x64");
}

// Linux x64 (AppImage)
const linuxFile = `${baseBuildPath}appimage/stuzhik_${version}_amd64.AppImage`;
if (await Bun.file(linuxFile).exists()) {
  const sigPath = `${linuxFile}.sig`;
  const signature = await Bun.file(sigPath).exists()
    ? (await Bun.file(sigPath).text()).trim()
    : undefined;

  platforms["linux-x86_64"] = {
    url: `${baseUrl}/stuzhik_${version}_amd64.AppImage`,
    signature,
  };
  console.log("  Linux x64");
}

// macOS x64 (Intel)
const macX64File = `${baseBuildPath}macos/stuzhik.app.tar.gz`;
if (await Bun.file(macX64File).exists()) {
  const sigPath = `${macX64File}.sig`;
  const signature = await Bun.file(sigPath).exists()
    ? (await Bun.file(sigPath).text()).trim()
    : undefined;

  platforms["darwin-x86_64"] = {
    url: `${baseUrl}/stuzhik_${version}_x64.app.tar.gz`,
    signature,
  };
  console.log("  macOS x64 (Intel)");
}

// macOS aarch64 (Apple Silicon)
const macArmFile = `${baseBuildPath}macos/stuzhik.app.tar.gz`;
// Note: Tauri creates universal binary or separate builds
// Check for aarch64 specific file first
const macArmSpecific = `${baseBuildPath}macos/stuzhik_aarch64.app.tar.gz`;
const macArmActual = await Bun.file(macArmSpecific).exists() ? macArmSpecific : null;
if (macArmActual) {
  const sigPath = `${macArmActual}.sig`;
  const signature = await Bun.file(sigPath).exists()
    ? (await Bun.file(sigPath).text()).trim()
    : undefined;

  platforms["darwin-aarch64"] = {
    url: `${baseUrl}/stuzhik_${version}_aarch64.app.tar.gz`,
    signature,
  };
  console.log("  macOS aarch64 (Apple Silicon)");
}

// Check if any platforms were found
if (Object.keys(platforms).length === 0) {
  console.error("No build artifacts found! Run 'bun tauri build' first.");
  process.exit(1);
}

const latestJson = {
  version,
  notes: "Bug fixes and improvements",
  pub_date: new Date().toISOString(),
  platforms,
};

// Write to bundle directory
const outputPath = "src-tauri/target/release/bundle/latest.json";
await Bun.write(outputPath, JSON.stringify(latestJson, null, 2));

console.log(`\nlatest.json generated for ${Object.keys(platforms).length} platform(s)`);
console.log(`Output: ${outputPath}`);
console.log(`Version: ${version}`);
