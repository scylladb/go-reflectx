# Release notes

Pushing an existing-style `vMAJOR.MINOR.PATCH` tag (for example, `v1.0.2`)
creates a published GitHub release with generated notes. Maintainers still choose
the version and create the tag; this workflow does not publish packages or change
Go compatibility. It verifies the pushed tag object and its commit, supports
annotated tags, and serializes runs for each tag. The tagged commit must contain
`.github/release.yml` with the canonical exclusion policy. Existing published
releases retain their curated notes on reruns; existing drafts fail visibly and
require maintainer review. Rerun a failed tag workflow after fixing its cause.

Generated notes omit PRs labeled `omit-from-release-notes`. Stock
`actions/labeler` uses `.github/labeler.yml` to apply that label only when all
reported changed filenames match known support material: `README.md`, this
document, root `*_test.go` files, `.travis.yml`, `.golangci.yml`, `.gitignore`,
the release-note and labeler policies, workflow YAML/helper JavaScript under
`.github`, and the exact private guard-tooling manifests `.github/package.json` and `.github/package-lock.json`. These private
Node dependencies support release automation only; they are not Go build inputs.
One brace-union glob allows mixtures of those support paths while requiring every
reported filename to match. Documentation remains eligible even
when it is included in a source archive. Production Go code, runtime manifests
(`go.mod`, `go.sum`), `Makefile`, license changes, unknown paths, and mixtures with
nonmatching files remain visible. Authors, PR titles, and broad chore/dependency
labels do not affect this rule. Extend the conservative allowlist explicitly
when the layout changes.

Labeling runs when a PR opens, changes, reopens, is edited, or closes. The workflow
first confirms the requested PR using its trusted matching PR event or an exact
PR lookup, before checking out trusted workflow tooling and installing its private
dependencies. An ordinary issue, unavailable lookup, mismatched response, or invalid
number cannot authorize label writes. Manual dispatch must use the default branch;
merged-PR backfills use current event tooling rather than the historical PR head
or base. PR code is never checked out.

The pinned `actions/labeler` remains the classifier, with `sync-labels: true` to
remove the omission label when filename rules stop matching. A guard reads the
same `.github/labeler.yml` policy, checks complete unique file metadata and stable
head/base revisions and file counts, and blocks omission for a rename whose prior
path is outside that policy. After the action, it compares the file snapshot and
checks the actual full omission-label name without case sensitivity. A failed or
unexpectedly skipped classification attempts removal of the omission label only
for a confirmed PR. That confirmation survives later checkout, install, helper,
or API failures; cleanup does not depend on installed tooling. Cleanup is best
effort: API outages can prevent removal. Before/after reads detect observed
changes but do not guarantee atomicity or race freedom.

Release publication remains asynchronous. Before pushing a version tag:

1. Identify the merged PRs included since the previous release.
2. For each PR, verify that its relevant **Classify release notes** run completed,
   including the final verification step. Backfill older or unclassified PRs from
   Actions → **Classify release notes** → **Run workflow**, select the default
   branch, and enter the PR number. The same workflow handles open and merged PRs
   and serializes runs by PR number. Wait for every relevant run to finish.
3. Inspect any failed run and its logs, compare the PR's actual changed paths
   (including rename origins) with `.github/labeler.yml`, and verify the actual
   `omit-from-release-notes` label matches those paths. Resolve failures and rerun
   classification as needed, then confirm successful final verification.
4. Push the chosen version tag only after these checks. Generated notes use the
   labels present when publication runs.

There is no automated release-ordering barrier. Missed manual verification can
leave omissions or unwanted support entries in published notes. Existing published
notes remain unchanged, and no follow-up synchronization is scheduled.

Run `npm ci --ignore-scripts --prefix .github` followed by
`node --test .github/scripts/*.test.cjs` for the isolated automation tests. They
exercise the actual workflow scripts and helper using controlled GitHub API
fixtures; they never publish a release or mutate GitHub.
