# Releases via release-please, with a moving `latest` branch

Releases are cut by `release-please-action` (Conventional Commits driven) on PR
merge to `main`. It bumps `package.json` + `CHANGELOG.md`, creates an immutable
`vX.Y.Z` tag, and a matching GitHub Release. A separate CI job force-pushes a
`latest` branch to the tip of `main` on every push, so `bunx
github:fveracoechea/multiplexer#latest` always resolves to the newest merged
code. `#latest` therefore means "newest on main", not "newest tagged release";
to pin a specific release, use `#vX.Y.Z`.

## Why a moving branch instead of a moving tag

A moving `latest` tag has a footgun: `git fetch` will not overwrite a tag that
already exists locally unless the user passes `--force`, so returning users get
a stale `latest` cached. A branch updates on every plain `git fetch`, which is
what consumers of `bunx github:...#latest` actually do.

## Why release-please over manual tags

Manual tags require a human to remember the version number, write a changelog,
and cut the release after each merge. release-please automates that and ties
the version bump to the actual change type (feat -> minor, fix -> patch) via
Conventional Commit PR titles. The trade-off is that PR titles must follow the
convention - enforced by convention only, not a commitlint gate.

## Why `private: true` is kept in package.json

The package is never published to npm. `bunx github:user/repo#ref` fetches the
repo tarball from GitHub and ignores `private`, so `private: true` does not
block `bunx` use. It correctly prevents an accidental `npm publish`.

## Initial version

`package.json` starts at `0.1.0`. release-please's first release after the next
`feat:` PR merge to `main` cuts `v0.1.0`.
