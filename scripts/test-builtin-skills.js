const { test } = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../lib/skills');
skills.loadAllSkills();
test('Meta skills follow the saved Meta Ads connection', () => {
  const connected = new Set(['meta_ads']);
  const store = { isConnected: service => connected.has(service) };
  let prompt = skills.getSkillsForPrompt(store, 'meta ads performance');
  assert.match(prompt, /--- SKILL: Meta Ads ---/);
  assert.doesNotMatch(prompt, /--- SKILL: Intelligence Loop ---/);
  connected.add('shopify');
  prompt = skills.getSkillsForPrompt(store, 'business intelligence revenue');
  assert.match(prompt, /--- SKILL: Intelligence Loop ---/);
  connected.clear();
  assert.doesNotMatch(skills.getSkillsForPrompt(store, 'meta ads performance'), /--- SKILL: Meta Ads ---/);
});
test('browser Instagram instructions require no ads connection', () => {
  const prompt = skills.getSkillsForPrompt({ isConnected: () => false }, 'comment on my instagram post');
  assert.match(prompt, /--- SKILL: Instagram \(Workspace browser\) ---/);
  assert.match(prompt, /sandbox_browse/);
});
