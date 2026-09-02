# OneMorePlat Library Scan

A [Tampermonkey](https://www.tampermonkey.net/) userscript that helps [OneMorePlat](https://onemoreplat.games) find games your account owns that Steam's own official sync APIs (`GetOwnedGames`, `GetRecentlyPlayedGames`) sometimes miss entirely -- a delisted game, a family-shared title, or a free game you own but have never launched.

## Why this exists

Steam's Web API doesn't always reflect everything an account has real access to. Steam's **own store front-end** doesn't have that problem: it reads an undocumented endpoint (`dynamicstore/userdata`) to build your library and wishlist pages, and that endpoint reflects raw ownership with no filtering at all. This script reads that endpoint from **your own logged-in browser session** -- nothing here touches, needs, or could touch any other account's data -- and reports the plain list of owned appIds to OneMorePlat, which queues it for its own background worker: each new appId gets independently verified against Steam's own achievement APIs before anything is added to your profile.

## What it actually does

- On `store.steampowered.com`: reads `dynamicstore/userdata` and sends the appId list to OneMorePlat, in a proper same-origin request -- no CORS workarounds needed for that part. OneMorePlat just queues it (there's no live processing to wait for -- a first scan on a large, long-unsynced library can take a while, so this always returns quickly). Runs automatically on any store page load (throttled server-side, so most loads are a no-op), and also whenever the button below opens the store this way.
- On your own `steamcommunity.com` profile page: shows a small panel with a **"Buscar juegos"** button and, underneath, when you last used it -- read from a plain cookie set on that page the moment you click it, **not** from anything OneMorePlat's server says. Clicking it opens the store front page in a new tab (a real HTML page, not `dynamicstore/userdata`'s raw JSON directly -- some browsers won't run a userscript reliably on that) which sends the list and closes itself once done. It checks that the profile being viewed is **your own** before showing anything -- it never appears on someone else's profile, and viewing someone else's profile never sends their data anywhere.

The script's own job stops at reading that appId list and normalizing it into a plain array -- no classification, no filtering, no verification, and no checking back for a result happens in the browser at all. All of that runs server-side, on OneMorePlat's own schedule; the script never asks it what it found.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Install the script: [onemoreplat-library-scan.user.js](https://raw.githubusercontent.com/SrGalletaEXT/onemoreplat-library-scan/main/onemoreplat-library-scan.user.js) (Tampermonkey will open its install prompt automatically).
3. Visit any Steam store page -- that's it, no further setup. Your Steam ID alone identifies your OneMorePlat account, the same way it already does for any of Steam's own APIs.

## Data sent

Only: your Steam ID (to identify your OneMorePlat account) and the plain list of appIds `dynamicstore/userdata` reports as owned. No wishlist, no friends list, no play history, no other account's data ever leaves your browser.

## Updates

Tampermonkey checks the `@updateURL` in this repo automatically; installing from the link above is enough to stay current.
