# Security Policy

## Supported versions

AnimeGo is developed on a rolling basis. Only the latest `main` branch (and the
currently deployed production version) receives security fixes.

| Version | Supported |
| ------- | --------- |
| `main` (latest) | ✅ |
| older commits / tags | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use one of these private channels:

1. **GitHub Security Advisories** (preferred) — open a private report via the
   repository's **Security → Report a vulnerability** page:
   <https://github.com/lawrenceli0228/animego/security/advisories/new>
2. **Email** — security@animegoclub.com

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected component/endpoint and, if known, a suggested fix.

## What to expect

This is a small, primarily solo-maintained project, so responses are
best-effort. We aim to acknowledge a report within a few days, keep you updated
on remediation, and credit you (if you wish) once a fix is released. Please give
us reasonable time to address an issue before any public disclosure.

## Scope

In scope: the application code in this repository (the Next.js app, the Go API,
the ws-server, and deployment configuration).

Out of scope: vulnerabilities in third-party services and data sources the
project integrates (e.g. AniList, Bangumi, MyAnimeList, dandanplay) — please
report those to their respective maintainers.
