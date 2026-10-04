// Re-running the installer is how ClosedHand updates. Each update replaces its
// images, and the replaced ones used to stay on disk for good (3 to 5 GB a
// time) until the disk filled. The installer notes the images it runs on
// before the update and removes exactly those once the new version answers.
// Runs the installer's own code against a stand-in docker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
const listing = install.match(/closedhand_images\(\) \{[\s\S]*?\n\}\n/)[0];
const cleanup = install.match(/if \[ "\$tries" -lt 45 \] && \[ -n "\$PREVIOUS_IMAGES" \]; then[\s\S]*?\nfi\n/)[0];

function update({ before, after, inUse = [], answered = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-clean-'));
  const ids = (m) => Object.entries(m).map(([img, id]) => `${img}) echo ${id} ;;`).join(' ');
  const file = path.join(dir, 'run.sh');
  fs.writeFileSync(file, `set -eu
STATE=before
step() { :; }
docker() {
  case "$1 $2" in
    "compose config") printf '%s\\n' ${Object.keys(before).join(' ')} ;;
    "image inspect") if [ "$STATE" = before ]; then case "$5" in ${ids(before)} esac; else case "$5" in ${ids(after)} esac; fi ;;
    "image rm") case " ${inUse.join(' ')} " in *" $3 "*) return 1 ;; esac; echo "removed $3" >> "${dir}/removed" ;;
  esac
}
${listing}
PREVIOUS_IMAGES=$(closedhand_images)
STATE=after
tries=${answered ? 3 : 45}
${cleanup}`);
  execFileSync('sh', [file], { encoding: 'utf8' });
  const log = path.join(dir, 'removed');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

test('an update removes the images it replaced, and only those', () => {
  const removed = update({
    before: { 'ghcr.io/x/closedhand-bot:latest': 'sha256:oldbot', 'ghcr.io/x/closedhand-webapp:latest': 'sha256:oldweb', 'pgvector/pgvector:pg16': 'sha256:pg' },
    after: { 'ghcr.io/x/closedhand-bot:latest': 'sha256:newbot', 'ghcr.io/x/closedhand-webapp:latest': 'sha256:newweb', 'pgvector/pgvector:pg16': 'sha256:pg' },
  });
  assert.deepEqual(removed, ['removed sha256:oldbot', 'removed sha256:oldweb'], 'the unchanged database image stays');
});

test('an image a container still uses is kept, and nothing goes if the new version never answered', () => {
  const before = { 'ghcr.io/x/closedhand-bot:latest': 'sha256:oldbot' };
  const after = { 'ghcr.io/x/closedhand-bot:latest': 'sha256:newbot' };
  assert.deepEqual(update({ before, after, inUse: ['sha256:oldbot'] }), []);
  assert.deepEqual(update({ before, after, answered: false }), []);
});

test('a first install has nothing to clear', () => {
  assert.deepEqual(update({ before: { 'ghcr.io/x/closedhand-bot:latest': '' }, after: { 'ghcr.io/x/closedhand-bot:latest': 'sha256:newbot' } }), []);
});

test('the images are noted before anything is pulled or built', () => {
  assert.ok(install.indexOf('PREVIOUS_IMAGES=$(closedhand_images)') < install.indexOf('pull_progress docker compose pull'));
  assert.ok(install.indexOf('PREVIOUS_IMAGES=$(closedhand_images)') < install.indexOf('up -d --build'));
});
