const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const POLICY = 'changelog:\n  exclude:\n    labels:\n      - omit-from-release-notes';

async function publish({github, context, core}, tag, expectedTagSHA) {
  const repo = context.repo;
  if (!TAG.test(tag) || !/^[0-9a-f]{40}$/.test(expectedTagSHA)) {
    throw new Error('Expected a vMAJOR.MINOR.PATCH tag and its pushed object SHA');
  }
  async function verifyTag() {
    let object = (await github.rest.git.getRef({...repo, ref: `tags/${tag}`})).data.object;
    if (object.sha !== expectedTagSHA) throw new Error('Remote tag differs from the pushed tag');
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
      object = (await github.rest.git.getTag({...repo, tag_sha: object.sha})).data.object;
    }
    if (object.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) {
      throw new Error('Release tag must resolve to a commit');
    }
    const commit = (await github.rest.git.getCommit({...repo, commit_sha: object.sha})).data;
    if (commit.sha !== object.sha) throw new Error('Release commit verification failed');
    return object.sha;
  }
  const commit = await verifyTag();
  async function existingRelease() {
    const releases = await github.paginate(github.rest.repos.listReleases,
      {...repo, per_page: 100});
    const release = releases.find(item => item.tag_name === tag);
    if (!release) return undefined;
    if (release.draft) throw new Error('Existing draft requires maintainer review before publication');
    core.info(`GitHub release already exists: ${release.html_url}`);
    return release;
  }
  const existing = await existingRelease();
  if (existing) return existing;
  const config = (await github.rest.repos.getContent({...repo,
    path: '.github/release.yml', ref: commit})).data;
  if (Buffer.from(config.content, 'base64').toString('utf8').replace(/\r/g, '').trim() !== POLICY) {
    throw new Error('Release tag must contain the canonical release-note exclusion policy');
  }
  const notes = (await github.rest.repos.generateReleaseNotes({...repo, tag_name: tag,
    configuration_file_path: '.github/release.yml'})).data;
  await verifyTag();
  try {
    return (await github.rest.repos.createRelease({...repo, tag_name: tag,
      target_commitish: commit, name: notes.name, body: notes.body,
      draft: false, prerelease: false})).data;
  } catch (error) {
    if (error.status === 422) {
      const created = await existingRelease();
      if (created) return created;
    }
    throw error;
  }
}

module.exports = {publish};
