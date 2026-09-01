# OneMorePlat Library Scan

A [Tampermonkey](https://www.tampermonkey.net/) userscript that helps [OneMorePlat](https://onemoreplat.games) find games your account owns that Steam's own official sync APIs (`GetOwnedGames`, `GetRecentlyPlayedGames`) sometimes miss entirely -- a delisted game, a family-shared title, or a free game you own but have never launched.

## Why this exists

Steam's Web API doesn't always reflect everything an account has real access to. Steam's **own store front-end** doesn't have that problem: it reads an undocumented endpoint (`dynamicstore/userdata`) to build your library and wishlist pages, and that endpoint reflects raw ownership with no filtering at all. This script reads that endpoint from **your own logged-in browser session** -- nothing here touches, needs, or could touch any other account's data -- and reports the plain list of owned appIds to OneMorePlat, which independently verifies each new one against Steam's own achievement APIs before adding anything to your profile.

## What it actually does

- On `store.steampowered.com`: reads `dynamicstore/userdata` (same-origin, your own session) and sends the appId list to OneMorePlat. This is throttled server-side (a few hours between real runs), so most page loads do nothing.
- On your own `steamcommunity.com` profile page: shows a small panel with the result of the last scan. It checks that the profile being viewed is **your own** before showing anything -- it never appears on someone else's profile, and viewing someone else's profile never sends their data anywhere.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Install the script: [onemoreplat-library-scan.user.js](https://raw.githubusercontent.com/SrGalletaEXT/onemoreplat-library-scan/main/onemoreplat-library-scan.user.js) (Tampermonkey will open its install prompt automatically).
3. Visit any Steam store page -- that's it, no further setup. Your Steam ID alone identifies your OneMorePlat account, the same way it already does for any of Steam's own APIs.

## Data sent

Only: your Steam ID (to identify your OneMorePlat account) and the plain list of appIds `dynamicstore/userdata` reports as owned. No wishlist, no friends list, no play history, no other account's data ever leaves your browser.

## Updates

Tampermonkey checks the `@updateURL` in this repo automatically; installing from the link above is enough to stay current.
