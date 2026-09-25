#!/usr/bin/env node
// The webapp is deployed separately. Ship only public skill metadata with it.
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../lib/skills');
const root = path.resolve(__dirname, '..');
const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, 'skills', entry.name, 'SKILL.md')))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(entry => {
    const { meta } = parseFrontmatter(fs.readFileSync(path.join(root, 'skills', entry.name, 'SKILL.md'), 'utf8'));
    return { id: entry.name, name: meta.name || entry.name, description: meta.description || '',
      requires_service: meta.requires_service || null, always_active: meta.always_active === 'true' || meta.always_active === true };
  });
const file = path.join(root, 'webapp/public/builtin-skills.json');
const expected = JSON.stringify(skills, null, 2) + '\n';
if (process.argv.includes('--update')) fs.writeFileSync(file, expected);
else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) {
  console.error('Built-in skill catalogue is stale. Run node scripts/check-builtin-skills.js --update.');
  process.exitCode = 1;
} else console.log('Built-in skill catalogue matches bundled skills.');
