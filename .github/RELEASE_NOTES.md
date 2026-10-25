# Release notes

Pushing an existing-style `vMAJOR.MINOR.PATCH` tag (for example, `v1.0.2`)
creates a published GitHub release with generated notes. Maintainers still choose
the version and create the tag; this workflow does not publish packages or change
Go compatibility. It verifies the pushed tag object and its commit, supports
annotated tags, and serializes runs for each tag. The tagged commit must contain
`.github/release.yml` with the canonical exclusion policy. Existing published
releases retain their curated notes on reruns; existing drafts fail visibly and
require maintainer review. Rerun a failed tag workflow after fixing its cause.
