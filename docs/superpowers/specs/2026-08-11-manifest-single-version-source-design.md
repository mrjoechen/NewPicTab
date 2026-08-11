# Manifest as the Single Release Version Source

## Goal

Make future PicTab releases require changing the product version in only one file before creating the matching Git tag.

## Design

`public/manifest.json` is the canonical PicTab product version. Chrome uses this value for extension updates, the built extension displays it at runtime, and the Chrome Web Store package validator already checks it against the requested release version.

`package.json` and `package-lock.json` describe the private Node.js build workspace rather than a published npm package. Their version fields will no longer participate in release validation and do not need to change for each PicTab release.

The GitHub Actions release workflow will continue to accept only tags in the exact `vX.Y.Z` format. It will derive `X.Y.Z` from the tag and compare that value only with `public/manifest.json`. A mismatch will stop the release before dependency installation, testing, building, packaging, or GitHub Release creation.

The packaging step remains unchanged. It passes the tag-derived version to `scripts/package-chrome-store.mjs`, which independently verifies that the built `dist/manifest.json` has the same version. This preserves an end-to-end guard between the source manifest, Git tag, and uploaded Chrome Web Store archive.

## Release Flow

For a release such as `0.1.2`:

1. Change only `public/manifest.json` from the previous version to `0.1.2`.
2. Commit that change.
3. Create and push tag `v0.1.2` from that commit.
4. GitHub Actions validates `v0.1.2` against manifest version `0.1.2`, runs the existing checks, builds the extension, packages the store ZIP, and creates the GitHub Release.

## Testing

Add a regression test that reads the release workflow as configuration and proves that:

- the manifest version is still loaded and compared with the tag-derived release version;
- the npm package version is not loaded or included in the release-version comparison;
- the existing packaging command still receives the tag-derived version.

Run the focused regression test first, then the full `npm run check` and a local Chrome Web Store packaging command using the current manifest version.

## Non-goals

- Automatically editing or committing the manifest from CI.
- Deriving the product version only from a Git tag.
- Publishing directly to the Chrome Web Store.
- Changing existing uncommitted documentation deletions or the current `0.1.1` manifest bump.
