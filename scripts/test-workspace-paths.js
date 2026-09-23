const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sandbox-image/agent/server.js'), 'utf8');
const implementation = source.slice(source.indexOf('function safePath('), source.indexOf('\nfunction truncate('));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closedhand-path-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  const outside = path.join(dir, 'workspace-other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'test fixture only');
  const validate = base => vm.runInNewContext(implementation + '\nsafePath', { fs, path, WORKSPACE: base });
  return { dir, workspace, outside, safe: validate(workspace), validate };
}

test('Workspace files, the root and new nested paths remain usable', t => {
  const { workspace, safe } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'saved.txt'), 'saved');
  assert.equal(safe('.'), workspace);
  assert.equal(safe('saved.txt'), path.join(workspace, 'saved.txt'));
  const target = safe('new/deep/file.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('a directory sharing the Workspace prefix cannot be read or written', t => {
  const { outside, safe } = fixture(t);
  for (const p of ['../workspace-other/private.txt', path.join(outside, 'private.txt'), path.join(outside, 'new.txt')]) {
    assert.throws(() => safe(p), /Path traversal blocked/);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'test fixture only');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('file and directory symlinks cannot escape the Workspace', t => {
  const { workspace, outside, safe } = fixture(t);
  fs.symlinkSync(outside, path.join(workspace, 'external'));
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(workspace, 'external-file'));
  for (const p of ['external-file', 'external/private.txt', 'external/new/deep.txt']) {
    assert.throws(() => safe(p), /Path traversal blocked/);
  }
});

test('dangling symlinks cannot redirect future writes', t => {
  const { workspace, outside, safe } = fixture(t);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(workspace, 'dangling'));
  assert.throws(() => safe('dangling/new.txt'), /Path traversal blocked/);
  assert.throws(() => safe('dangling'), /Path traversal blocked/);
});

test('symlinks pointing inside the Workspace remain usable', t => {
  const { workspace, safe } = fixture(t);
  fs.mkdirSync(path.join(workspace, 'folder'));
  fs.symlinkSync(path.join(workspace, 'folder'), path.join(workspace, 'alias'));
  assert.equal(safe('alias/new.txt'), path.join(workspace, 'alias/new.txt'));
});

test('a Workspace reached through a symlink still checks the real boundary', t => {
  const { dir, workspace, outside, validate } = fixture(t);
  const alias = path.join(dir, 'workspace-link');
  fs.symlinkSync(workspace, alias);
  fs.symlinkSync(outside, path.join(workspace, 'escape'));
  const safe = validate(alias);
  assert.equal(safe('new.txt'), path.join(alias, 'new.txt'));
  assert.throws(() => safe('escape/private.txt'), /Path traversal blocked/);
});
