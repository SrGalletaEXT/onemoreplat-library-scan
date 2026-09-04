# OneMorePlat Library Scan

A [Tampermonkey](https://www.tampermonkey.net/) userscript that helps [OneMorePlat](https://onemoreplat.games) find games your account has real access to that Steam's own official sync APIs (`GetOwnedGames`, `GetRecentlyPlayedGames`) sometimes miss entirely -- a delisted game, a family-shared title, or a free game you own but have never launched.

## Why this exists

Steam's Web API doesn't always reflect everything an account has real access to. Steam's **own store front-end** doesn't have that problem: it reads an undocumented endpoint (`dynamicstore/userdata`) to build your library and wishlist pages, and that endpoint reflects raw ownership with no filtering at all. This script reads that endpoint from **your own logged-in browser session** -- nothing here touches, needs, or could touch any other account's data -- and reports the plain list of owned appIds to OneMorePlat, which queues it for its own background worker: each new appId gets independently verified against Steam's own achievement APIs before anything is added to your profile.

Family-shared games are a separate gap this also closes: a game someone else in your Steam Family Group shared with you never shows up in `rgOwnedApps` or `GetOwnedGames` at all -- you don't hold a license for it, you're just allowed to launch it. This script also resolves your own Family Group and reports which shared appIds aren't ones you own outright, the same way it already does for `rgOwnedApps` -- OneMorePlat's backend independently checks your real achievement progress on each one before ever adding it, since being shared into the group isn't proof you've actually played it.

## What it actually does

- On `store.steampowered.com`: reads `dynamicstore/userdata` and your Family Group's shared library, and sends both lists to OneMorePlat. OneMorePlat just queues them (there's no live processing to wait for -- a first scan on a large, long-unsynced library can take a while, so this always returns quickly). Runs automatically on any store page load (throttled server-side, so most loads are a no-op).
- On your own `steamcommunity.com` profile page: shows a small panel with a **"Buscar juegos"** button. Clicking it reads both of the above and sends them right there, via `GM_xmlhttpRequest` -- no popup, no new tab. That API isn't subject to the page's CORS policy, so it works fine across origins and still carries your real store.steampowered.com session cookies. The button waits for OneMorePlat to actually confirm it received the list before showing success; the "last sent" time shown underneath (a plain cookie on this page, **not** anything read back from OneMorePlat's server) only updates on that confirmation, never just because the button was clicked. It checks that the profile being viewed is **your own** before showing anything -- it never appears on someone else's profile, and viewing someone else's profile never sends their data anywhere.
- The Family Group check uses a short-lived access token Steam's own store front-end already hands your logged-in session for its own client-side features (not a login credential -- it can't do anything your browser's existing session couldn't already do). If it fails for any reason (no Family Group, Steam changed something), it's caught and logged to the console -- it never blocks the `dynamicstore/userdata` report, which always gets sent regardless.

The script's own job stops at reading these appId lists and normalizing them into plain arrays -- no classification, no filtering, no verification happens in the browser at all. All of that runs server-side, on OneMorePlat's own schedule; the script only ever finds out whether the lists were *received*, never what OneMorePlat did with them.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Install the script: [onemoreplat-library-scan.user.js](https://raw.githubusercontent.com/SrGalletaEXT/onemoreplat-library-scan/main/onemoreplat-library-scan.user.js) (Tampermonkey will open its install prompt automatically).
3. Visit any Steam store page -- that's it, no further setup. Your Steam ID alone identifies your OneMorePlat account, the same way it already does for any of Steam's own APIs.

## Rare cases: manual cross-checking

The automatic checks above (`dynamicstore/userdata` + your *current* Family Group) cover almost everything, but not quite all of it. A game that was family-shared with you in the past and isn't anymore is the known example: the achievement progress is real and permanently yours, but a *current* Family Group check has no way to see a share that no longer exists.

For these rare, one-off cases there's a separate comparison script that cross-checks your progress against other public Steam achievement trackers and flags any appId gaps. It's intentionally **not** part of this repo, not installed automatically, and never runs on its own -- it only gets handed out directly, by hand, on the rare occasion a specific case actually needs it.

If you're given that script:

1. Install it in Tampermonkey the same way as this one, and run it on your own Steam Community profile -- let it finish comparing before reading the results.
2. Copy the appId(s) it flags as missing from OneMorePlat (comma-separated).
3. Paste them into the **"Añadir por ID"** box below the "Buscar juegos" button on your OneMorePlat profile panel (that panel comes from *this* script). They go through the exact same verification and sync as anything found automatically -- just entered by hand instead of discovered on their own.

This is a last resort, not a replacement for anything above -- most accounts never need it.

## Data sent

Your Steam ID (to identify your OneMorePlat account), the plain list of appIds `dynamicstore/userdata` reports as owned, and the plain list of appIds your Steam Family Group shares with you that you don't already own outright. No wishlist, no friends list, no play history, no other account's data ever leaves your browser.

## Updates

Tampermonkey checks the `@updateURL` in this repo automatically; installing from the link above is enough to stay current.
