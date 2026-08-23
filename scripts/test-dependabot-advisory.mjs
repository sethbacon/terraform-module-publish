// The Dependabot advisory in .github/workflows/ci.yml is a diagnosis, and a
// diagnosis nobody checks drifts into confident misdirection: it will keep
// naming a lockfile regression long after the branch that detects one has
// stopped matching npm's wording, sending every future reader to regenerate a
// lockfile that was never the problem.
//
// So this does not re-implement the advisory -- it EXTRACTS the `run:` block
// from the committed workflow and executes that, against real npm output. A
// copy would pass while the workflow rotted.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/ci.yml';
const STEP = 'What to do about this Dependabot bump';

function extractRunBlock(yaml, stepName) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  if (at === -1) throw new Error(`step "${stepName}" not found in ${WORKFLOW}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|/.test(l));
  if (runAt === -1) throw new Error(`step "${stepName}" has no "run: |" block`);
  const indent = lines[runAt].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const yaml = readFileSync(WORKFLOW, 'utf8');
const script = extractRunBlock(yaml, STEP);

// If the block interpolated ${{ }} it would not be this script that CI runs,
// and executing it here would prove nothing about the real thing. It is also
// the shell-injection sink: github.head_ref is attacker-chosen text.
if (script.includes('${{')) {
  throw new Error('advisory run block interpolates ${{ }}; it must read inputs from env');
}

const SYNC_FAILURE = `npm error code EUSAGE
npm error
npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.
npm error
npm error Missing: @rolldown/binding-darwin-x64@1.2.5 from lock file
npm error Missing: @rolldown/binding-linux-arm64-gnu@1.2.5 from lock file
npm error
npm error Clean install a project`;

const OTHER_FAILURE = `npm error code ENOTFOUND
npm error network request to https://registry.npmjs.org/vitest failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org`;

function run({ install, rebuild, log }) {
  const dir = mkdtempSync(join(tmpdir(), 'advisory-'));
  writeFileSync(join(dir, 'npm-ci.log'), log ?? '');
  return execFileSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HEAD_REF: 'dependabot/npm_and_yarn/vitest-4.1.11',
      INSTALL: install,
      REBUILD: rebuild,
      NPM_CI_LOG: join(dir, 'npm-ci.log'),
    },
  });
}

const cases = [
  {
    name: 'a lockfile npm ci refuses names the regression and both missing packages',
    input: { install: 'failure', rebuild: 'skipped', log: SYNC_FAILURE },
    expect: (out) =>
      out.startsWith('::error::') &&
      out.includes('lockfile update is incomplete') &&
      out.includes('@rolldown/binding-darwin-x64@1.2.5') &&
      out.includes('@rolldown/binding-linux-arm64-gnu@1.2.5') &&
      out.includes('npm install --package-lock-only'),
  },
  {
    name: 'an npm ci failure that is NOT a sync refusal is not diagnosed as one',
    input: { install: 'failure', rebuild: 'skipped', log: OTHER_FAILURE },
    expect: (out) =>
      out.startsWith('::error::') &&
      out.includes('NOT a lockfile-sync refusal') &&
      !out.includes('lockfile update is incomplete') &&
      // It may NAME the lockfile remedy in order to rule it out; what it must
      // not do is hand over the recipe, which is what a reader acts on.
      !out.includes('git fetch origin'),
  },
  {
    name: 'a bundle that cannot be built still says so, and never says rebuild-and-commit',
    input: { install: 'success', rebuild: 'failure', log: '' },
    expect: (out) =>
      out.startsWith('::error::') &&
      out.includes('cannot be built from it') &&
      !out.includes('::notice::'),
  },
  {
    name: 'a clean build with a stale dist gets the rebuild-and-commit recipe',
    input: { install: 'success', rebuild: 'success', log: '' },
    expect: (out) =>
      out.startsWith('::notice::') &&
      out.includes('the only thing missing is the committed dist/') &&
      out.includes('npm run build'),
  },
];

let failed = 0;
for (const c of cases) {
  let out;
  try {
    out = run(c.input).trim();
  } catch (err) {
    console.error(`FAIL  ${c.name}\n      advisory exited nonzero: ${err.message}`);
    failed++;
    continue;
  }
  if (c.expect(out)) {
    console.log(`ok    ${c.name}`);
  } else {
    console.error(`FAIL  ${c.name}\n      got: ${out}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} advisory checks failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} advisory checks passed`);
