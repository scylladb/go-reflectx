// Copyright ScyllaDB, Inc. SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const yaml = require('js-yaml');
const guard = require('./release-notes-guard.cjs');

const repo = {owner: 'scylladb', repo: 'go-reflectx'};
const label = 'omit-from-release-notes';
const file = (filename, extra = {}) => ({filename, status: 'modified', ...extra});
const workflowText = readFileSync(join(__dirname, '../workflows/label-release-notes.yml'), 'utf8');
const workflow = yaml.load(workflowText);
const steps = workflow.jobs.classify.steps;
const scripts = steps.filter(step => step.with?.script).map(step => step.with.script);
const collectScript = steps.find(step => step.id === 'guard').with.script;
const confirmScript = steps.find(step => step.id === 'target').with.script;
const verifyScript = steps.at(-1).with.script;
const toolingRequire = path => require(join(__dirname, '../..', path));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fixture(options = {}) {
  const files = options.files ?? [file('README.md')];
  const labels = new Set(options.labels ?? ['unrelated']);
  const calls = [];
  let gets = 0;
  let listings = 0;
  const initial = {number: 20, head: {sha: 'head'}, base: {sha: 'base'}, changed_files: files.length};
  const github = {rest: {pulls: {
    get: async params => {
      assert.deepEqual(params, {...repo, pull_number: 20});
      calls.push('get');
      gets++;
      if (options.failGetAt === gets) throw Object.assign(new Error('PR lookup unavailable'),
        {status: options.failGetStatus});
      return {data: {...initial, ...options.revisions?.[gets - 1]}};
    },
    listFiles: () => {}
  }, issues: {
    listLabelsOnIssue: () => {},
    removeLabel: async params => {
      assert.deepEqual(params, {...repo, issue_number: 20, name: label});
      calls.push('remove');
      if (options.cleanupFailure) throw new Error('Removal unavailable');
      // GitHub looks up the logical label without case sensitivity while
      // preserving its stored spelling in returned metadata.
      const actual = [...labels].find(name => name.toLowerCase() === label);
      if (actual === undefined) throw {status: 404};
      labels.delete(actual);
    }
  }}, paginate: async (method, params) => {
    assert.equal(params.per_page, 100);
    if (method === github.rest.pulls.listFiles) {
      assert.deepEqual(params, {...repo, pull_number: 20, per_page: 100});
      calls.push('files');
      if (options.fileFailure) throw new Error('File listing unavailable');
      return options.listings?.[listings++] ?? files;
    }
    assert.equal(method, github.rest.issues.listLabelsOnIssue);
    assert.deepEqual(params, {...repo, issue_number: 20, per_page: 100});
    calls.push('labels');
    if (options.labelFailure) throw new Error('Labels unavailable');
    return options.labelMetadata ?? [...labels].map(name => ({name}));
  }};
  return {github, labels, calls};
}

async function adapter(f, hash, overrides = {}, load = toolingRequire) {
  const env = {PR_NUMBER: '20', CONFIRMED_PR: 'true', TARGET_OUTCOME: 'success',
    CHECKOUT_OUTCOME: 'success', INSTALL_OUTCOME: 'success',
    GUARD_OUTCOME: 'success', LABELER_OUTCOME: 'success', UNSAFE_RENAME: 'false',
    SNAPSHOT_HASH: hash, ...overrides};
  const logs = [];
  const run = new AsyncFunction('github', 'context', 'core', 'require', 'process', verifyScript);
  let error;
  try {
    await run(f.github, {repo}, {info: text => logs.push(text), error: text => logs.push(text)},
      load, {env});
  } catch (caught) { error = caught; }
  return {error, logs};
}

test('canonical policy matches mixed support files and keeps runtime or unknown paths visible', async () => {
  const files = ['README.md', 'reflect_test.go', 'example_test.go', '.github/RELEASE_NOTES.md',
    '.github/release.yml', '.github/labeler.yml', '.github/workflows/release.yml',
    '.github/workflows/check.yaml', '.github/scripts/release-notes-guard.cjs',
    '.github/package.json', '.github/package-lock.json', '.gitignore', '.travis.yml', '.golangci.yml']
    .map(name => file(name));
  assert.equal((await guard.snapshot(fixture({files}).github, repo, 20)).omit, true);
  for (const name of ['reflect.go', 'transform.go', 'go.mod', 'go.sum', 'Makefile', 'LICENSE',
    '.github/unknown.txt', '.github/node_modules/lib.js', 'docs/guide.md', 'nested/reflect_test.go', 'unknown.txt']) {
    const current = await guard.snapshot(fixture({files: [...files, file(name)]}).github, repo, 20);
    assert.equal(current.omit, false, name);
  }
});

test('renames use the actual canonical policy for both prior and current paths', async () => {
  for (const [previous, omit] of [['README.md', true], ['reflect.go', false], ['unknown', false]]) {
    const current = await guard.snapshot(fixture({files: [file('.github/RELEASE_NOTES.md', {
      status: 'renamed', previous_filename: previous})]}).github, repo, 20);
    assert.equal(current.omit, omit);
    assert.equal(current.unsafeRename, !omit);
  }
});

test('support-to-runtime renames remain visible without skipping the stock action', async () => {
  const current = await guard.snapshot(fixture({files: [file('reflect.go', {
    status: 'renamed', previous_filename: 'reflect_test.go'})]}).github, repo, 20);
  assert.equal(current.omit, false);
  assert.equal(current.unsafeRename, false);
});

test('unsupported config shapes fail instead of approximating a second policy', () => {
  for (const source of ['{}', 'omit-from-release-notes: []',
    'omit-from-release-notes: [{head-branch: [main]}]',
    'omit-from-release-notes: [{changed-files: [{any-glob-to-any-file: ["**"]}]}]',
    'omit-from-release-notes: [{changed-files: [{all-globs-to-all-files: []}]}]',
    'other-label: [{changed-files: [{all-globs-to-all-files: ["**"]}]}]']) {
    assert.throws(() => guard.policy(source), /Unsupported labeler configuration/);
  }
});

test('PR input rejects malformed, ambiguous and unsafe numbers', () => {
  assert.equal(guard.parseNumber('20'), 20);
  for (const value of ['', '0', '-1', '01', '1.0', '1e2', ' 20', '20\n',
    '20,21', '${{ arbitrary }}', '9007199254740992', undefined, 20]) {
    assert.throws(() => guard.parseNumber(value), /canonical positive safe PR number/);
  }
});

test('pagination requests full metadata and accepts a complete listing beyond one page', async () => {
  const f = fixture({files: Array.from({length: 105}, (_, i) => file(`fixture_${i}_test.go`))});
  const snapshot = await guard.snapshot(f.github, repo, 20);
  assert.equal(snapshot.count, 105);
  assert.equal(snapshot.omit, true);
  assert.match(snapshot.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.calls, ['get', 'files', 'get']);
});

test('zero, incomplete, truncated, duplicate and invalid file evidence fail visibly', async () => {
  const cases = [
    {files: []},
    {revisions: [{changed_files: 2}, {changed_files: 2}]},
    {files: [file('README.md'), file('README.md')]},
    {files: [file('README.md', {status: 'renamed'})]},
    {files: [file('README.md', {status: undefined})]},
    {files: [{filename: '', status: 'modified'}]},
    {files: [file('README.md', {status: 'invalid'})]},
    {revisions: [{head: {sha: 42}}]},
    {revisions: [{base: {sha: ''}}]},
    {files: [file('README.md', {previous_filename: ''})]},
    {files: [file('README.md')], listings: [[]]}
  ];
  for (const options of cases) await assert.rejects(guard.snapshot(fixture(options).github, repo, 20));
});

test('head, base and count changes during collection are rejected', async () => {
  for (const changed of [{head: {sha: 'new'}}, {base: {sha: 'new'}}, {changed_files: 2}]) {
    const f = fixture({revisions: [{}, changed]});
    await assert.rejects(guard.snapshot(f.github, repo, 20), /revisions changed/);
  }
});

test('verification detects before/after revisions and filename, status or prior-path changes', async () => {
  const original = await guard.snapshot(fixture().github, repo, 20);
  for (const options of [
    {revisions: [{head: {sha: 'new'}}, {head: {sha: 'new'}}]},
    {revisions: [{base: {sha: 'new'}}, {base: {sha: 'new'}}]},
    {files: [file('example_test.go')]},
    {files: [file('README.md', {status: 'added'})]},
    {files: [file('README.md', {status: 'renamed', previous_filename: 'reflect_test.go'})]}
  ]) {
    await assert.rejects(guard.verify(fixture(options).github, repo, 20, original.hash), /snapshot changed/);
  }
  const f = fixture({labels: [label], revisions: [{}, {}, {head: {sha: 'new'}}]});
  await assert.rejects(guard.verify(f.github, repo, 20, original.hash), /revisions changed during label/);
});

test('lookup, listing and actual-label lookup failures propagate', async () => {
  await assert.rejects(guard.snapshot(fixture({failGetAt: 1}).github, repo, 20), /lookup unavailable/);
  await assert.rejects(guard.snapshot(fixture({failGetAt: 2}).github, repo, 20), /lookup unavailable/);
  await assert.rejects(guard.snapshot(fixture({fileFailure: true}).github, repo, 20), /listing unavailable/);
  const original = await guard.snapshot(fixture().github, repo, 20);
  await assert.rejects(guard.verify(fixture({labelFailure: true}).github, repo, 20, original.hash), /Labels unavailable/);
});

test('actual-label verification catches stale state after internal action skip', async () => {
  for (const [files, labels] of [[[file('README.md')], []], [[file('transform.go')], [label]]]) {
    const f = fixture({files, labels: [...labels, 'unrelated']});
    const original = await guard.snapshot(f.github, repo, 20);
    const {error} = await adapter(f, original.hash);
    assert.match(error.message, /Actual omission label/);
    assert.equal(f.labels.has(label), false);
    assert.equal(f.labels.has('unrelated'), true);
    assert.equal(f.calls.filter(call => call === 'remove').length, 1);
  }
});

test('failed final snapshot, lookup or label retrieval attempts cleanup', async () => {
  const original = await guard.snapshot(fixture().github, repo, 20);
  for (const options of [{files: [file('example_test.go')]}, {failGetAt: 1},
    {fileFailure: true}, {labelFailure: true}]) {
    const f = fixture({...options, labels: [label, 'unrelated']});
    const {error} = await adapter(f, original.hash);
    assert.ok(error);
    assert.deepEqual([...f.labels], ['unrelated']);
    assert.equal(f.calls.filter(call => call === 'remove').length, 1);
  }
});

test('successful verification checks actual labels and preserves unrelated labels', async () => {
  for (const [files, labels] of [[[file('README.md')], [label]], [[file('transform.go')], []]]) {
    const f = fixture({files, labels: [...labels, 'unrelated']});
    const original = await guard.snapshot(f.github, repo, 20);
    const {error, logs} = await adapter(f, original.hash);
    assert.ifError(error);
    assert.match(logs[0], /Verified head=head base=base count=1 snapshot=.*actual label checked/);
    assert.equal(f.labels.has('unrelated'), true);
    assert.ok(!f.calls.includes('remove'));
  }
});

test('actual logical marker identity preserves support omissions and rejects runtime omissions regardless of casing', async () => {
  const marker = 'Omit-from-release-notes';
  const other = 'OMIT-FROM-RELEASE-NOTES-extra';
  const prefix = 'prefix-omit-from-release-notes';
  for (const [name, omit] of [['README.md', true], ['reflect.go', false]]) {
    const f = fixture({files: [file(name)], labels: [marker, other, prefix, 'unrelated']});
    const original = await guard.snapshot(f.github, repo, 20);
    const {error} = await adapter(f, original.hash);
    if (omit) {
      assert.ifError(error);
      assert.equal(f.labels.has(marker), true);
      assert.ok(!f.calls.includes('remove'));
    } else {
      assert.match(error.message, /Actual omission label/);
      assert.equal(f.labels.has(marker), false);
      assert.equal(f.calls.filter(call => call === 'remove').length, 1);
    }
    assert.equal(f.labels.has(other), true);
    assert.equal(f.labels.has(prefix), true);
    assert.equal(f.labels.has('unrelated'), true);
  }
});

test('invalid actual-label metadata fails verification and attempts canonical cleanup', async () => {
  const original = await guard.snapshot(fixture().github, repo, 20);
  for (const item of [null, {}, {name: 42}, {name: ''}]) {
    const f = fixture({labels: [label, 'unrelated'], labelMetadata: [item]});
    const {error} = await adapter(f, original.hash);
    assert.match(error.message, /Invalid label metadata/);
    assert.deepEqual([...f.labels], ['unrelated']);
    assert.equal(f.calls.filter(call => call === 'remove').length, 1);
  }
});

test('intentional unsafe-rename skip removes omission label and verifies visible state', async () => {
  const f = fixture({files: [file('README.md', {status: 'renamed', previous_filename: 'reflect.go'})],
    labels: [label, 'unrelated']});
  const original = await guard.snapshot(f.github, repo, 20);
  const {error, logs} = await adapter(f, original.hash, {UNSAFE_RENAME: 'true', LABELER_OUTCOME: 'skipped'});
  assert.ifError(error);
  assert.match(logs[0], /omit=false; actual label checked/);
  assert.deepEqual([...f.labels], ['unrelated']);
  assert.equal(f.calls.filter(call => call === 'remove').length, 1);
});

test('failed or skipped setup, guard and labeler clean up without requiring the helper', async () => {
  for (const key of ['TARGET_OUTCOME', 'CHECKOUT_OUTCOME', 'INSTALL_OUTCOME', 'GUARD_OUTCOME', 'LABELER_OUTCOME']) {
    for (const outcome of ['failure', 'skipped', 'cancelled', '']) {
      const f = fixture({labels: [label, 'unrelated']});
      const {error} = await adapter(f, '', {[key]: outcome}, () => { throw new Error('Must not require helper'); });
      assert.match(error.message, /predecessor failed or unexpectedly skipped/);
      assert.deepEqual([...f.labels], ['unrelated']);
      assert.deepEqual(f.calls, ['remove']);
    }
  }
  const f = fixture({labels: [label]});
  const {error} = await adapter(f, '', {}, () => { throw new Error('Helper missing'); });
  assert.match(error.message, /Helper missing/);
  assert.deepEqual(f.calls, ['remove']);
});

test('cleanup API failures remain visible without losing the original failure or retrying', async () => {
  const f = fixture({cleanupFailure: true});
  const result = await adapter(f, '', {INSTALL_OUTCOME: 'failure'});
  assert.match(result.error.message, /predecessor failed/);
  assert.match(result.logs[0], /cleanup failed: Removal unavailable/);
  assert.deepEqual(f.calls, ['remove']);
  const unsafe = fixture({cleanupFailure: true});
  const result2 = await adapter(unsafe, '', {UNSAFE_RENAME: 'true', LABELER_OUTCOME: 'skipped'});
  assert.match(result2.error.message, /Removal unavailable/);
  assert.deepEqual(unsafe.calls, ['remove']);
});

async function confirm(f, context = {repo, eventName: 'workflow_dispatch'}) {
  const outputs = {};
  const run = new AsyncFunction('github', 'context', 'core', 'process', confirmScript);
  let error;
  try {
    await run(f.github, context, {setOutput: (key, value) => {outputs[key] = value;}},
      {env: {PR_NUMBER: '20'}});
  } catch (caught) {error = caught;}
  return {outputs, error};
}

test('target confirmation precedes checkout and accepts manual PR or trusted PR event identity', async () => {
  assert.ok(steps.findIndex(step => step.id === 'target') < steps.findIndex(step => step.id === 'checkout'));
  const manual = fixture();
  const first = await confirm(manual);
  assert.ifError(first.error);
  assert.deepEqual(first.outputs, {'confirmed-pr': 'true'});
  assert.deepEqual(manual.calls, ['get']);
  const event = fixture({failGetAt: 1});
  const second = await confirm(event, {repo, eventName: 'pull_request_target',
    payload: {pull_request: {number: 20}}});
  assert.ifError(second.error);
  assert.deepEqual(second.outputs, {'confirmed-pr': 'true'});
  assert.deepEqual(event.calls, []);
});

test('ordinary issue, unavailable lookup and mismatched identity never enable label mutation', async () => {
  for (const options of [{failGetAt: 1}, {failGetAt: 1, failGetStatus: 404},
    {revisions: [{number: 21}]}]) {
    const f = fixture({...options, labels: [label, 'unrelated']});
    const target = await confirm(f);
    assert.ok(target.error);
    assert.deepEqual(target.outputs, {});
    const result = await adapter(f, '', {CONFIRMED_PR: '', TARGET_OUTCOME: 'failure'},
      () => {throw new Error('Must not load helper for unconfirmed target');});
    assert.match(result.error.message, /not confirmed as a pull request/);
    assert.deepEqual([...f.labels], [label, 'unrelated']);
    assert.ok(!f.calls.includes('remove'));
  }
  const issue = fixture({labels: [label, 'unrelated']});
  issue.github.rest.pulls.get = async () => {throw {status: 404};};
  const target = await confirm(issue);
  assert.equal(target.error.status, 404);
  const result = await adapter(issue, '', {CONFIRMED_PR: '', TARGET_OUTCOME: 'failure'});
  assert.match(result.error.message, /labels were not changed/);
  assert.deepEqual([...issue.labels], [label, 'unrelated']);
  assert.ok(!issue.calls.includes('remove'));
});

test('confirmed manual PR retains helper-independent cleanup after later failures', async () => {
  for (const key of ['CHECKOUT_OUTCOME', 'INSTALL_OUTCOME', 'GUARD_OUTCOME', 'LABELER_OUTCOME']) {
    const f = fixture({labels: [label, 'unrelated']});
    const target = await confirm(f);
    assert.ifError(target.error);
    const result = await adapter(f, '', {CONFIRMED_PR: target.outputs['confirmed-pr'], [key]: 'failure'},
      () => {throw new Error('Must not need helper for predecessor failure');});
    assert.match(result.error.message, /predecessor failed/);
    assert.deepEqual([...f.labels], ['unrelated']);
    assert.deepEqual(f.calls, ['get', 'remove']);
  }
});

test('workflow adapters use environment input and emit bounded verified snapshot outputs', async () => {
  const run = new AsyncFunction('github', 'context', 'core', 'require', 'process', collectScript);
  const outputs = {};
  const f = fixture();
  await run(f.github, {repo}, {setOutput: (key, value) => { outputs[key] = value; }, info: () => {}},
    toolingRequire, {env: {PR_NUMBER: '20'}});
  assert.deepEqual(Object.keys(outputs), ['hash', 'unsafe-rename']);
  assert.equal(outputs['unsafe-rename'], 'false');
  const invalid = await adapter(f, '', {PR_NUMBER: '01'});
  assert.match(invalid.error.message, /canonical positive safe PR number/);
  assert.equal(steps.at(-1).if, 'always()');
  assert.equal(steps.find(step => step.id === 'checkout').with.ref, '${{ github.sha }}');
  assert.equal(steps.find(step => step.id === 'checkout').with['persist-credentials'], false);
  assert.equal(steps.find(step => step.id === 'install').run, 'npm ci --ignore-scripts --prefix .github');
  const action = steps.find(step => step.id === 'labeler');
  assert.equal(action.if, "success() && steps.guard.outputs.unsafe-rename == 'false'");
  assert.equal(action.with['sync-labels'], true);
  assert.equal(action.with['pr-number'], '${{ env.PR_NUMBER }}');
  for (const script of scripts) assert.ok(!script.includes('${{'));
});

test('merged-PR backfills load event tooling rather than the old PR base or head', () => {
  const expression = steps.find(step => step.id === 'checkout').with.ref.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const checkoutRef = new Function('github', `return ${expression}`);
  for (const event of [{pull_request: {head: {sha: 'untrusted'}, base: {sha: 'old-base'}}}, {}]) {
    assert.equal(checkoutRef({sha: 'trusted-default-event', event}), 'trusted-default-event');
  }
});

test('dispatch precondition rejects non-default refs before checkout and unconfirmed cleanup', async () => {
  assert.equal(steps[0].name, 'Require default-branch manual dispatch');
  const run = new AsyncFunction('context', steps[0].with.script);
  const payload = {repository: {default_branch: 'master'}};
  await run({eventName: 'workflow_dispatch', ref: 'refs/heads/master', payload});
  await run({eventName: 'pull_request_target', ref: 'refs/heads/release-branch', payload});
  for (const ref of ['refs/heads/feature', 'refs/tags/v1.2.3']) {
    await assert.rejects(run({eventName: 'workflow_dispatch', ref, payload}), /repository default branch/);
  }
  const f = fixture({labels: [label, 'unrelated']});
  const {error} = await adapter(f, '', {CONFIRMED_PR: '', TARGET_OUTCOME: 'skipped',
    CHECKOUT_OUTCOME: 'skipped', INSTALL_OUTCOME: 'skipped', GUARD_OUTCOME: 'skipped',
    LABELER_OUTCOME: 'skipped'}, () => {throw new Error('Must not load helper');});
  assert.match(error.message, /not confirmed as a pull request/);
  assert.deepEqual([...f.labels], [label, 'unrelated']);
  assert.deepEqual(f.calls, []);
});

// Execute the parsed job's scripts, environment and predecessor outcomes. External
// checkout/install/labeler actions are controlled substitutes, not live services.
async function runJob(f, options = {}, config = workflow) {
  const context = {repo, eventName: options.eventName ?? 'workflow_dispatch',
    ref: 'refs/heads/master', payload: {repository: {default_branch: 'master'},
      ...(options.eventName === 'pull_request_target' ? {pull_request: {number: 20}} : {})}};
  const state = {github: {event: context.payload}, inputs: {'pull-request': options.number ?? '20'},
    steps: {}, env: {}};
  const resolve = value => typeof value !== 'string' ? value : value.replace(/\$\{\{\s*(.*?)\s*\}\}/g,
    (_, expression) => expression.split(' || ').map(term => term.trim().split('.')
      .reduce((object, key) => object?.[key], state)).find(Boolean) ?? '');
  state.env = Object.fromEntries(Object.entries(config.jobs.classify.env).map(([key, value]) => [key, resolve(value)]));
  let failed = false;
  const errors = [];
  for (const [index, step] of config.jobs.classify.steps.entries()) {
    const record = {outputs: {}, outcome: 'skipped'};
    if (step.id) state.steps[step.id] = record;
    const allowed = step.if === 'always()' || (!failed && (!step.if ||
      (step.if === "success() && steps.guard.outputs.unsafe-rename == 'false'" &&
       state.steps.guard.outputs['unsafe-rename'] === 'false')));
    if (!allowed) continue;
    const env = {...state.env, ...Object.fromEntries(Object.entries(step.env ?? {})
      .map(([key, value]) => [key, resolve(value)]))};
    try {
      if (options.fail && options.fail === step.id) throw new Error(`Controlled ${step.id} failure`);
      if (step.with?.script) {
        const execute = new AsyncFunction('github', 'context', 'core', 'require', 'process', step.with.script);
        await execute(f.github, context, {setOutput: (key, value) => {record.outputs[key] = value;},
          info: () => {}, error: () => {}}, path => {
          if (options.helperMissing) throw new Error('Helper missing');
          return toolingRequire(path);
        }, {env});
      } else if (step.id === 'labeler') {
        assert.equal(resolve(step.with['pr-number']), '20');
        assert.equal(step.with['configuration-path'], '.github/labeler.yml');
        assert.equal(step.with['sync-labels'], true);
        f.calls.push('labeler');
        f.labels.add(label); // Successful support-only action substitute.
      }
      record.outcome = 'success';
    } catch (error) {
      record.outcome = 'failure';
      failed = true;
      errors.push({step: step.id ?? index, error});
    }
  }
  return {state, errors};
}

function assertCleanup(f) {
  assert.equal(f.calls.filter(call => call === 'remove').length, 1);
  assert.equal(f.labels.has(label), false);
}

test('parsed job wires canonical manual input, target persistence and real helper through final verification', async () => {
  const f = fixture();
  const result = await runJob(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.state.env.PR_NUMBER, '20');
  assert.equal(result.state.steps.target.outputs['confirmed-pr'], 'true');
  assert.equal(f.labels.has(label), true);
  assert.deepEqual(f.calls, ['get', 'get', 'files', 'get', 'labeler', 'get', 'files', 'get', 'labels', 'get']);
  const testWorkflow = yaml.load(readFileSync(join(__dirname, '../workflows/release-notes-tests.yml'), 'utf8'));
  const commands = testWorkflow.jobs.tests.steps.map(step => step.run).filter(Boolean);
  assert.deepEqual(commands, ['npm ci --ignore-scripts --prefix .github', 'node --test .github/scripts/*.test.cjs']);
});

test('parsed job leaves unconfirmed targets untouched and confirmed PRs retain cleanup after setup failures', async () => {
  for (const options of [{failGetAt: 1}, {failGetAt: 1, failGetStatus: 404},
    {revisions: [{number: 21}]}]) {
    const f = fixture({...options, labels: [label]});
    const result = await runJob(f);
    assert.ok(result.errors.length);
    assert.ok(!f.calls.includes('remove') && !f.calls.includes('labeler'));
  }
  for (const number of ['01', '0', '9007199254740992', '20\n']) {
    const f = fixture({labels: [label]});
    await runJob(f, {number});
    assert.deepEqual(f.calls, []);
  }
  for (const fail of ['checkout', 'install', 'guard', 'labeler']) {
    const f = fixture({labels: [label], ...(fail === 'labeler' ? {} : {failGetAt: 2})});
    const result = await runJob(f, {fail});
    assert.ok(result.errors.length);
    assertCleanup(f);
    assert.deepEqual(f.calls, fail === 'labeler' ? ['get', 'get', 'files', 'get', 'remove'] : ['get', 'remove']);
  }
  const missing = fixture({labels: [label]});
  await runJob(missing, {helperMissing: true});
  assertCleanup(missing);
  const trusted = fixture({labels: [label], failGetAt: 1});
  await runJob(trusted, {eventName: 'pull_request_target'});
  assertCleanup(trusted);
  assert.deepEqual(trusted.calls, ['get', 'remove']);
});

test('focused mutations expose lost confirmation safety, late confirmation and broken persisted output wiring', async () => {
  const withoutGate = structuredClone(workflow);
  withoutGate.jobs.classify.steps.at(-1).with.script = verifyScript.replace(
    "if (process.env.CONFIRMED_PR !== 'true')", 'if (false)');
  const ordinary = fixture({labels: [label]});
  ordinary.github.rest.pulls.get = async () => {throw {status: 404};};
  await runJob(ordinary, {}, withoutGate);
  assert.throws(() => assert.equal(ordinary.calls.includes('remove'), false));

  const late = structuredClone(workflow);
  const targetIndex = late.jobs.classify.steps.findIndex(step => step.id === 'target');
  const [target] = late.jobs.classify.steps.splice(targetIndex, 1);
  late.jobs.classify.steps.splice(targetIndex + 1, 0, target);
  const setup = fixture({labels: [label]});
  await runJob(setup, {fail: 'checkout'}, late);
  assert.throws(() => assertCleanup(setup));

  const disconnected = structuredClone(workflow);
  disconnected.jobs.classify.steps.at(-1).env.CONFIRMED_PR = '${{ steps.guard.outputs.confirmed-pr }}';
  const persisted = fixture({labels: [label]});
  await runJob(persisted, {fail: 'install'}, disconnected);
  assert.throws(() => assertCleanup(persisted));

  const wrongInput = structuredClone(workflow);
  wrongInput.jobs.classify.env.PR_NUMBER = '${{ inputs.pull_request }}';
  const input = fixture({labels: [label]});
  await runJob(input, {fail: 'checkout'}, wrongInput);
  assert.throws(() => assertCleanup(input));
});

test('actual helper-path mutation fails collection and still cleans up a confirmed PR', async () => {
  const config = structuredClone(workflow);
  const step = config.jobs.classify.steps.find(item => item.id === 'guard');
  step.with.script = step.with.script.replace('release-notes-guard.cjs', 'missing-helper.cjs');
  const f = fixture({labels: [label]});
  const result = await runJob(f, {}, config);
  assert.match(result.errors[0].error.message, /Cannot find module/);
  assertCleanup(f);
  assert.ok(!f.calls.includes('labeler'));
});

test('empty actual label collection is valid for runtime changes', async () => {
  const f = fixture({files: [file('reflect.go')], labels: []});
  const original = await guard.snapshot(f.github, repo, 20);
  assert.equal((await guard.verify(f.github, repo, 20, original.hash)).omit, false);
});
