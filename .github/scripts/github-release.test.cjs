const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {publish} = require('./github-release.cjs');
const sha = 'a'.repeat(40);
const tag = 'v1.0.2';

function fixture() {
  const calls = [];
  const pages = [[]];
  const policy = readFileSync('.github/release.yml', 'utf8');
  const release = {html_url: 'https://github.com/scylladb/go-reflectx/releases/tag/v1.0.2',
    tag_name: tag, draft: false, body: 'Curated release text'};
  const api = {
    github: {rest: {
      git: {
        getRef: async () => ({data: {object: {type: 'commit', sha}}}),
        getTag: async () => ({data: {object: {type: 'commit', sha}}}),
        getCommit: async args => ({data: {sha: args.commit_sha}}),
      },
      repos: {
        listReleases: async () => ({data: pages[0]}),
        getContent: async args => {
          assert.equal(args.ref, sha);
          assert.equal(args.path, '.github/release.yml');
          calls.push('config');
          return {data: {content: Buffer.from(policy).toString('base64')}};
        },
        generateReleaseNotes: async args => {
          assert.equal(args.tag_name, tag);
          assert.equal(args.configuration_file_path, '.github/release.yml');
          calls.push('generate');
          return {data: {name: tag, body: 'Filtered generated notes'}};
        },
        createRelease: async args => {
          calls.push(['create', args]);
          return {data: release};
        },
      },
    }},
    context: {repo: {owner: 'scylladb', repo: 'go-reflectx'}},
    core: {info: () => {}},
  };
  api.github.paginate = async (method, args) => {
    assert.equal(method, api.github.rest.repos.listReleases);
    assert.deepEqual(args, {owner: 'scylladb', repo: 'go-reflectx', per_page: 100});
    calls.push('lookup');
    return pages.flat();
  };
  return {api, calls, release, pages};
}

test('only canonical existing-style version tags and full object SHAs are accepted', async () => {
  for (const invalid of ['1.0.2', 'v01.0.2', 'v1.0', 'v1.0.2-rc.1', '../x']) {
    const {api, calls} = fixture();
    await assert.rejects(publish(api, invalid, sha), /Expected/);
    assert.deepEqual(calls, []);
  }
  await assert.rejects(publish(fixture().api, tag, 'abc'), /Expected/);
});

test('create release using canonical filtered generated notes for verified pushed tag', async () => {
  const {api, calls} = fixture();
  await publish(api, tag, sha);
  assert.deepEqual(calls.slice(0, 3), ['lookup', 'config', 'generate']);
  assert.equal(calls[3][1].body, 'Filtered generated notes');
  assert.equal(calls[3][1].draft, false);
  assert.equal(calls[3][1].tag_name, tag);
  assert.equal(calls[3][1].target_commitish, sha);
});

test('annotated tags are peeled before verification', async () => {
  const {api} = fixture();
  api.github.rest.git.getRef = async () => ({data: {object: {type: 'tag', sha: 'b'.repeat(40)}}});
  await publish(api, tag, 'b'.repeat(40));
});

test('missing or conflicting remote tag never creates a release', async () => {
  for (const missing of [true, false]) {
    const {api, calls} = fixture();
    api.github.rest.git.getRef = async () => {
      if (missing) throw {status: 404};
      return {data: {object: {type: 'commit', sha: 'b'.repeat(40)}}};
    };
    await assert.rejects(publish(api, tag, sha));
    assert.deepEqual(calls, []);
  }
});

test('existing published releases retain curated notes and require no regeneration', async () => {
  const {api, calls, release, pages} = fixture();
  pages[0].push(release);
  assert.equal((await publish(api, tag, sha)).body, 'Curated release text');
  assert.deepEqual(calls, ['lookup']);
});

test('existing draft requires visible maintainer intervention', async () => {
  const {api, calls, release, pages} = fixture();
  pages[0] = Array.from({length: 100}, (_, i) => ({tag_name: `v0.0.${i}`, draft: true}));
  pages.push([{...release, draft: true}]);
  await assert.rejects(publish(api, tag, sha), /Existing draft/);
  assert.deepEqual(calls, ['lookup']);
});

test('concurrent creation recovers only when a published release exists', async () => {
  const {api, release, calls, pages} = fixture();
  api.github.rest.repos.createRelease = async args => {
    calls.push(['create', args]);
    pages[0].push(release);
    throw {status: 422};
  };
  assert.equal(await publish(api, tag, sha), release);
  assert.equal(calls.filter(call => call === 'lookup').length, 2);
  assert.equal(calls.filter(call => call === 'generate').length, 1);
});

test('API failures and targets without canonical config fail without publishing', async () => {
  for (const failure of ['lookup', 'config', 'policy', 'generate', 'create']) {
    const {api, calls} = fixture();
    const repos = api.github.rest.repos;
    if (failure === 'lookup') api.github.paginate = async () => {throw {status: 403};};
    if (failure === 'config') repos.getContent = async () => {throw {status: 404};};
    if (failure === 'policy') repos.getContent = async () => ({data: {content: Buffer.from('changelog: {}').toString('base64')}});
    if (failure === 'generate') repos.generateReleaseNotes = async () => {throw {status: 500};};
    if (failure === 'create') repos.createRelease = async args => {
      calls.push(['create', args]);
      throw {status: 422};
    };
    await assert.rejects(publish(api, tag, sha));
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'create'),
      failure === 'create');
  }
});

test('tag movement during note generation cannot publish a different commit', async () => {
  const {api, calls} = fixture();
  const generate = api.github.rest.repos.generateReleaseNotes;
  api.github.rest.repos.generateReleaseNotes = async args => {
    api.github.rest.git.getRef = async () => ({data: {object: {type: 'commit', sha: 'b'.repeat(40)}}});
    return generate(args);
  };
  await assert.rejects(publish(api, tag, sha), /Remote tag differs/);
  assert.equal(calls.some(call => Array.isArray(call)), false);
});

test('invalid annotated targets and mismatched commit responses fail visibly', async () => {
  for (const failure of ['tree', 'cycle', 'commit']) {
    const {api, calls} = fixture();
    if (failure === 'tree') api.github.rest.git.getRef = async () => ({data: {object: {type: 'tree', sha}}});
    if (failure === 'cycle') {
      api.github.rest.git.getRef = async () => ({data: {object: {type: 'tag', sha}}});
      api.github.rest.git.getTag = api.github.rest.git.getRef;
    }
    if (failure === 'commit') api.github.rest.git.getCommit = async () => ({data: {sha: 'b'.repeat(40)}});
    await assert.rejects(publish(api, tag, sha));
    assert.deepEqual(calls, []);
  }
});

test('creation conflict cannot silently accept a draft', async () => {
  const {api, release, calls, pages} = fixture();
  api.github.rest.repos.createRelease = async args => {
    calls.push(['create', args]);
    pages[0].push({...release, draft: true});
    throw {status: 422};
  };
  await assert.rejects(publish(api, tag, sha), /Existing draft/);
  assert.equal(calls.filter(call => call === 'lookup').length, 2);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'create').length, 1);
});

test('release workflow executes a trusted helper with per-tag concurrency', () => {
  const release = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(release, /tags: \['v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*'\]/);
  assert.match(release, /group: github-release-\$\{\{ github.ref \}\}/);
  assert.match(release, /RELEASE_TAG_SHA: \$\{\{ github.event.after \}\}/);
  assert.match(release, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(release, /persist-credentials: false/);
  assert.match(release, /cancel-in-progress: false/);
});

test('unrelated releases do not prevent creating the exact requested tag', async () => {
  const {api, calls, release, pages} = fixture();
  pages[0].push({...release, tag_name: `${tag}-other`, draft: true});
  await publish(api, tag, sha);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'create').length, 1);
});

test('release listing errors including not-found never permit creation', async () => {
  for (const status of [403, 404, 500]) {
    const {api, calls} = fixture();
    const error = {status};
    api.github.paginate = async () => {throw error;};
    await assert.rejects(publish(api, tag, sha), actual => actual === error);
    assert.deepEqual(calls, []);
  }
});
