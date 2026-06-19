# Contributing to AnimeGo

Thanks for your interest in contributing! AnimeGo is a full-stack anime
discovery, tracking, and local-playback platform. This document explains how to
get a change merged, the licensing terms your contribution falls under, and
which parts of the codebase are open to external contributions.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License & Developer Certificate of Origin (DCO)

AnimeGo is licensed under the **GNU AGPL-3.0** (see [LICENSE](LICENSE)).

**By submitting a pull request, you agree that your contribution is licensed
under the AGPL-3.0**, and you certify the [Developer Certificate of
Origin](DCO) (DCO 1.1) for every commit.

We use the **DCO instead of a CLA**: you keep the copyright to your work and
simply certify that you have the right to submit it. To certify, sign off each
commit:

```bash
git commit -s -m "feat: add seasonal calendar filter"
```

This appends a line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name/email must match the commit author. PRs whose commits are not signed
off cannot be merged. (You can amend an existing commit with
`git commit --amend -s`, or sign off a range with an interactive rebase.)

---

## Scope: what's open to contributions

**In scope** — contributions are welcome here:

- The local video player, danmaku (bullet comments), dandanplay matching, and
  subtitle rendering
- Discovery, seasonal browsing, search, watchlist/tracking, and account flows
- UI/UX, accessibility, internationalization (i18n), SEO, and performance
- Anime metadata, enrichment matching, and data quality
- Infrastructure, CI/CD, Docker, tests, and documentation
- Bug fixes anywhere in the above

**Out of scope — not accepted as external contributions:**

The torrent/magnet **metadata-search subsystem** is maintained **solely by the
project owner** for legal and maintenance reasons, and is **not open to external
code contributions**. This covers:

- `go-api/internal/torrents/**`
- `next-app/src/components/anime/TorrentModal.tsx`
- `next-app/src/components/anime/torrentModalLogic.ts` (and its tests)
- any new or modified magnet/torrent **source adapters**

Pull requests that add, modify, extend, or add new sources to this subsystem
will be **closed without merge**. Bug *reports* (issues) about it are fine —
just please don't send code for this area. This boundary is enforced through
[`.github/CODEOWNERS`](.github/CODEOWNERS).

---

## How to contribute

1. **Open an issue first** for anything non-trivial (a bug, or a feature via the
   templates) so we can agree on the approach before you invest time.
2. **Fork** the repo and create a topic branch off `main`:
   `git checkout -b feat/short-description`
3. **Make focused changes.** Keep PRs small and single-purpose; split unrelated
   changes into separate PRs.
4. **Write tests** for new behavior and bug fixes (see below).
5. **Sign off your commits** (DCO, above) and follow
   [Conventional Commits](https://www.conventionalcommits.org/) for messages:
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`.
6. **Open a pull request**, fill in the template, and make sure CI is green.

### Local setup & tests

See the [README](README.md) for the full dev environment. The headline test
commands the CI gate runs:

```bash
# Go API
cd go-api && go test ./...        # some integration tests use testcontainers (Docker required)

# Next.js app
cd next-app && bun test           # unit tests
                                  # Jest + Playwright E2E also run in CI
```

Please run the relevant suites locally before opening a PR, and keep or improve
coverage for the code you touch.

### Style

- Match the conventions of the surrounding code.
- TypeScript/JS: ESLint + Prettier. Go: `gofmt`/`go vet`.
- Prefer small, cohesive files and explicit error handling.

---

## Reporting bugs & requesting features

Use the **issue templates** (Bug report / Feature request). Search existing
issues and discussions first to avoid duplicates.

## Security

**Do not** report security vulnerabilities through public issues. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## Questions

Open a [Discussion](https://github.com/lawrenceli0228/animego/discussions) for
questions, ideas, and general help.
