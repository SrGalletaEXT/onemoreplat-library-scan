# Factum Library Scan

A [Tampermonkey](https://www.tampermonkey.net/) userscript that helps [Factum / OneMorePlat](https://onemoreplat.games) find games your account owns that Steam's own official sync APIs (`GetOwnedGames`, `GetRecentlyPlayedGames`) sometimes miss entirely -- a delisted game, a family-shared title, or a free game you own but have never launched.

## Why this exists

Steam's Web API doesn't always reflect everything an account has real access to. Steam's **own store front-end** doesn't have that problem: it reads an undocumented endpoint (`dynamicstore/userdata`) to build your library and wishlist pages, and that endpoint reflects raw ownership with no filtering at all. This script reads that endpoint from **your own logged-in browser session** -- nothing here touches, needs, or could touch any other account's data -- and reports the plain list of owned appIds to Factum, which independently verifies each new one against Steam's own achievement APIs before adding anything to your profile.

## What it actually does

- On `store.steampowered.com`: reads `dynamicstore/userdata` (same-origin, your own session) and sends the appId list to Factum. This is throttled server-side (a few hours between real runs), so most page loads do nothing.
- On your own `steamcommunity.com` profile page: shows a small panel with the result of the last scan. It checks that the profile being viewed is **your own** before showing anything -- it never appears on someone else's profile, and viewing someone else's profile never sends their data anywhere.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Install the script: [factum-library-scan.user.js](https://raw.githubusercontent.com/SrGalletaEXT/factum-library-scan/main/factum-library-scan.user.js) (Tampermonkey will open its install prompt automatically).
3. In Factum, go to **Settings -> Sync via browser script** and generate a token.
4. Visit any Steam store page -- the script will ask you to paste that token once, and remembers it from then on.

To change the token later (e.g. after regenerating it in Factum's Settings), use the script's own menu command from the Tampermonkey icon: **Factum Library Scan -> Set sync token**.

## Data sent

Only: your Steam ID (to identify your Factum account) and the plain list of appIds `dynamicstore/userdata` reports as owned. No wishlist, no friends list, no play history, no other account's data ever leaves your browser.

## Updates

Tampermonkey checks the `@updateURL` in this repo automatically; installing from the link above is enough to stay current.
