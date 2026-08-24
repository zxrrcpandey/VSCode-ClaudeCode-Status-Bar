#!/usr/bin/env node
/*
 * Builds claude-pulse-<version>.vsix without @vscode/vsce (which needs
 * Node 20+). A .vsix is just a zip with a manifest; this generates both
 * manifest files from package.json and zips the extension files.
 *
 * Usage: node scripts/build-vsix.js      → ./claude-pulse-<version>.vsix
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = ['package.json', 'extension.js', 'usage-scan.js', 'buddy.html', 'README.md', 'LICENSE'];
// hooks/ ships too: the extension keeps the installed hook in sync with it.
const DIRS = ['media', 'hooks'];

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-vsix-'));
const ext = path.join(build, 'extension');
fs.mkdirSync(ext);
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(ext, f));
for (const d of DIRS) {
  fs.mkdirSync(path.join(ext, d));
  for (const f of fs.readdirSync(path.join(ROOT, d))) fs.copyFileSync(path.join(ROOT, d, f), path.join(ext, d, f));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
fs.writeFileSync(path.join(build, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension="" ContentType="text/plain"/>
</Types>
`);
fs.writeFileSync(path.join(build, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}"/>
    <DisplayName>${esc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description || '')}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`);

const out = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);
fs.rmSync(out, { force: true });
cp.execFileSync('zip', ['-q', '-r', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: build });
fs.rmSync(build, { recursive: true, force: true });
console.log('Built ' + path.relative(ROOT, out));
