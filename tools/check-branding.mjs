import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skippedDirectories = new Set([
  '.git', '.wrangler', '.tmpshots', 'dist', 'node_modules', 'shots',
]);
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.py', '.svg', '.yml', '.yaml',
]);
const errors = [];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function requireFile(file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) errors.push(`missing required file: ${file}`);
  return absolute;
}

const requiredFiles = [
  'README.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'TRADEMARKS.md',
  'LICENSE',
  '.github/CODEOWNERS',
  '.github/workflows/quality.yml',
];
requiredFiles.forEach(requireFile);

const files = walk(root);
const markdown = files.filter((file) => path.extname(file).toLowerCase() === '.md');
const noticeParts = [
  'ProSpacer™',
  'Copyright © 2026 Profexor',
  'trademark rights',
];

for (const file of markdown) {
  const contents = fs.readFileSync(file, 'utf8');
  for (const part of noticeParts) {
    if (!contents.toLowerCase().includes(part.toLowerCase())) {
      errors.push(`${relative(file)} is missing notice text: ${part}`);
    }
  }
}

const licensePath = path.join(root, 'LICENSE');
if (fs.existsSync(licensePath)) {
  const license = fs.readFileSync(licensePath, 'utf8');
  if (!license.startsWith('MIT License')) errors.push('LICENSE is not the expected MIT license');
  if (!license.includes('Copyright (c) 2026 Profexor')) {
    errors.push('LICENSE is missing the Profexor copyright line');
  }
}

const packagePath = path.join(root, 'package.json');
if (fs.existsSync(packagePath)) {
  const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageData.name !== 'prospacer') errors.push('package name must be prospacer');
  if (packageData.author !== 'Profexor') errors.push('package author must be Profexor');
  if (packageData.license !== 'MIT') errors.push('package license must be MIT');
}

const forbidden = [
  ['retired project title', ['the long', ' silence'].join('')],
  ['retired package name', ['the-long', '-silence'].join('')],
  ['retired project owner', ['An', 'shu', ' Chi', 'mala'].join('')],
  ['retired account handle', ['achi', 'mala'].join('')],
  ['retired deployment host', ['long', 'silence', '.an', 'shu.dev'].join('')],
  ['ambiguous archive product term', ['cod', 'ex'].join('')],
  ['unwanted vendor brand', ['open', 'ai'].join('')],
  ['unwanted assistant brand', ['chat', 'gpt'].join('')],
];

for (const file of files) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const contents = fs.readFileSync(file, 'utf8').toLowerCase();
  for (const [label, value] of forbidden) {
    if (contents.includes(value.toLowerCase())) {
      errors.push(`${relative(file)} contains ${label}`);
    }
  }
}

if (errors.length) {
  console.error('Branding integrity check failed:\n');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Branding integrity passed: ${markdown.length} Markdown files checked.`);
console.log('MIT ownership: Profexor. Project identity: ProSpacer™.');
