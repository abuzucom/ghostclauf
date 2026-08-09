# Public Site

`site/` is the GitHub Pages artifact for `ghost.clauf.org`. It is a static,
manual snapshot. It does not read bot state at runtime.

The site self-hosts Libre Franklin and Cousine under their SIL Open Font
License 1.1 terms. License copies are in `site/fonts/`.

## Export

Run `./publish-site.sh` on Linux or macOS, or double-click `publish-site.bat`
on Windows, on the trusted bot host. The script exports, lints, and validates
the public snapshot. It requires Python 3 for the artifact-boundary check. The
export command reads the configured fun-fact, quote, and loyalty store paths and writes only
`site/data/public.json`. It exports facts, quote text and speaker, and public
leaderboard display names and balances. It omits store keys, Twitch IDs,
curator data, timestamps, grants, redemptions, decisions, and backups.

Review `site/data/public.json` before committing it. Do not copy `data/`,
`config.yaml`, `.env`, token stores, or backup files into `site/`.

## Publish And Roll Back

Run `npm run lint:site` and `python scripts/check_public_site.py` before
opening a pull request. The Pages workflow deploys `site/` after changes to
the primary branch. Roll back by reverting the published site commit, then let
the workflow deploy the restored artifact.

Configure the GitHub Pages custom domain as `ghost.clauf.org`. Set the DNS
record required by GitHub Pages, enable HTTPS in repository settings, and
verify the certificate after DNS propagation.

## Removal

Remove an entry from its private source store, run the export again, review the
snapshot, and publish the result. A deployment cannot remove copies already
saved by third parties or cached outside GitHub Pages.
