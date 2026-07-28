# ProSpacer Security Policy

Profexor maintains the security of the ProSpacer source, build workflow, and distributed web assets.

## Supported versions

| Version | Security updates |
|---|---|
| Latest `main` | Supported |
| Older snapshots | Best effort |

Until formal releases begin, fixes land on `main`.

## Report a vulnerability

Use a private GitHub security advisory:

<https://github.com/jennofrie/ProSpacer/security/advisories/new>

Include:

- affected commit or version;
- impact and realistic attack scenario;
- reproduction steps or a minimal proof of concept;
- affected browsers or deployment configuration;
- suggested mitigation, if known.

Do not publish exploitable details in an issue, discussion, pull request, screenshot, or gameplay capture before a fix is available.

## Response process

Profexor will aim to:

1. acknowledge a complete report within three business days;
2. validate severity and affected scope;
3. prepare a fix and regression check;
4. coordinate disclosure when users can reasonably update;
5. credit reporters only when they explicitly request it.

Timelines vary with severity and reproducibility.

## Security scope

Relevant areas include:

- dependency or build-chain compromise;
- cross-site scripting or unsafe dynamic markup;
- unsafe deployment headers;
- exposed credentials or private endpoints;
- malicious save or imported content handling;
- browser API misuse that crosses expected permission boundaries.

Game balance, visual artifacts, unsupported hardware, and performance regressions belong in normal issue forms unless they create a security impact.

## Dependency practice

- Commit lockfile updates.
- Review transitive changes.
- Run `npm ci`, `npm audit`, and `npm run check`.
- Avoid runtime dependencies for development-only convenience.
- Never commit tokens, deployment secrets, or local credential files.

---

ProSpacer™ and its visual identity are trademarks of Profexor. Copyright © 2026 Profexor. The software is licensed under the [MIT License](LICENSE); trademark rights are not granted by the software license.
