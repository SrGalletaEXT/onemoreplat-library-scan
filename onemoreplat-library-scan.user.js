// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      6.0.0
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_xmlhttpRequest
// @connect      onemoreplat.games
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/SrGalletaEXT/onemoreplat-library-scan/main/onemoreplat-library-scan.user.js
// @downloadURL  https://raw.githubusercontent.com/SrGalletaEXT/onemoreplat-library-scan/main/onemoreplat-library-scan.user.js
// ==/UserScript==

/*
 * What this does, in plain terms:
 *
 * Steam's own official sync APIs (GetOwnedGames, GetRecentlyPlayedGames) don't always list
 * everything an account actually has access to -- a delisted game, a family-shared one, or a
 * free game you own but have never launched can all be genuinely invisible to them. Steam's
 * OWN store front-end doesn't have this problem: the same undocumented endpoint
 * (dynamicstore/userdata) it reads to build your library/wishlist pages reflects raw
 * ownership, no filtering. This script reads that endpoint from YOUR OWN logged-in session --
 * nothing it does requires (or uses) any other account's data -- and reports the plain list of
 * owned appIds to OneMorePlat. The script's own job stops right there: no classification, no
 * verification, no waiting to see what OneMorePlat did with it -- that's all server-side, on
 * its own schedule, and this script never asks it for the result back.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata (same-origin) and sends the list.
 *    Runs automatically on any store page load (silent; the server's own per-account cooldown
 *    means most loads are a no-op), and ALSO whenever a "Buscar juegos" click below opens the
 *    store this way.
 *  - steamcommunity.com profile pages: shows a small panel with a **"Buscar juegos"** button
 *    and, underneath, when you last used it -- read from a plain cookie set on THIS page the
 *    moment you click it, not from anything OneMorePlat's server says. Clicking the button
 *    opens the store front page in a new tab (a real HTML page, deliberately NOT
 *    dynamicstore/userdata directly: that endpoint returns raw JSON, which some browsers
 *    render as a built-in JSON viewer instead of a normal document a userscript can reliably
 *    run on) tagged with a URL flag so that tab closes itself once it's sent the list. Only
 *    ever shown on your OWN profile (compares the logged-in session's steamID against the
 *    profile being viewed) -- it never appears on anyone else's profile, and viewing someone
 *    else's profile never sends their data anywhere; the library read is always tied to your
 *    own session, never to whichever profile happens to be open.
 *
 * No setup needed beyond installing this -- your Steam ID alone identifies your OneMorePlat
 * account, same as it already does for any of Steam's own APIs.
 */

(function () {
  'use strict';

  const API_BASE = 'https://onemoreplat.games/api';
  const DYNAMICSTORE_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
  const LAST_SENT_COOKIE = 'onemoreplat_last_sent';
  // A real HTML page (not dynamicstore/userdata's raw JSON) for the "Buscar juegos" button to
  // open -- see the header comment for why. The query param is just a signal that tab reads
  // back below to know it should close itself once it's sent the list.
  const AUTO_CLOSE_PARAM = 'onemoreplat_scan';
  const STORE_ENTRY_URL = `https://store.steampowered.com/?${AUTO_CLOSE_PARAM}=1`;

  // GM_xmlhttpRequest, not fetch: this is a cross-origin POST (store.steampowered.com ->
  // onemoreplat.games). A plain fetch would need CORS headers OneMorePlat's backend doesn't
  // send for arbitrary origins and doesn't need to -- GM_xmlhttpRequest isn't subject to the
  // page's CORS policy at all, it's the browser extension itself making the request.
  function queueLibraryScan(steamId, appIds) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_BASE}/sync/library-scan`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ steamId, appIds }),
        onload: (res) => (res.status >= 200 && res.status < 300 ? resolve() : reject(new Error(`HTTP ${res.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timed out'))
      });
    });
  }

  async function fetchOwnedAppIds() {
    const response = await fetch(DYNAMICSTORE_URL, { credentials: 'include' });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  // The script's whole job: read the account's own appId list, normalize it (just "is this
  // actually an array of appIds"), and hand it off -- no classification, no filtering, no
  // verification, and no waiting around for a result, that's all server-side from here.
  async function runOnStorePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }
    try {
      const appIds = await fetchOwnedAppIds();
      if (appIds.length > 0) {
        await queueLibraryScan(g_steamID, appIds);
      }
    } catch (error) {
      console.warn('[OneMorePlat Library Scan]', error);
    } finally {
      // Only present when this tab was opened by the profile page's "Buscar juegos" button
      // (see STORE_ENTRY_URL) -- organic browsing never carries this param, so this never
      // closes a tab the user opened themselves. window.close() only works on a tab opened by
      // script (window.open), which this always is in that case.
      const params = new URLSearchParams(location.search);
      if (params.has(AUTO_CLOSE_PARAM)) {
        window.close();
      }
    }
  }

  function resolveProfileOwnerSteamId() {
    // Steam exposes this on every profile page for the account being VIEWED -- distinct from
    // g_steamID, which is the account currently logged in (present on every Steam page, not
    // just profiles).
    if (typeof g_rgProfileData !== 'undefined' && g_rgProfileData && g_rgProfileData.steamid) {
      return g_rgProfileData.steamid;
    }
    return null;
  }

  // Plain cookie on steamcommunity.com -- deliberately local, not a read from OneMorePlat's
  // own server: this only ever records "you clicked the button on THIS page", nothing about
  // what actually happened to the data afterwards. 1 year is just "keep it around", not a
  // meaningful expiry.
  function readLastSentCookie() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${LAST_SENT_COOKIE}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeLastSentCookie() {
    const oneYear = 365 * 24 * 60 * 60;
    document.cookie = `${LAST_SENT_COOKIE}=${encodeURIComponent(new Date().toISOString())}; max-age=${oneYear}; path=/; SameSite=Lax`;
  }

  function runOnProfilePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }

    const profileOwnerSteamId = resolveProfileOwnerSteamId();
    if (!profileOwnerSteamId || profileOwnerSteamId !== g_steamID) {
      // Only ever shown on your OWN profile -- viewing someone else's never triggers this,
      // and never sends anything either.
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'onemoreplat-library-scan-panel';
    panel.style.cssText =
      'background:#1b2838;color:#c7d5e0;padding:10px 14px;margin:10px 0;' +
      'border-radius:4px;font-size:13px;line-height:1.4;border:1px solid #2a475e;' +
      'display:flex;align-items:center;justify-content:space-between;gap:12px;';

    const label = document.createElement('span');
    const button = document.createElement('button');
    button.textContent = 'Buscar juegos';
    button.style.cssText =
      'background:#2a475e;color:#c7d5e0;border:1px solid #66c0f4;border-radius:3px;' +
      'padding:5px 12px;font-size:12px;cursor:pointer;flex:0 0 auto;';

    function renderLabel() {
      const lastSent = readLastSentCookie();
      label.textContent = lastSent
        ? `OneMorePlat: último envío ${new Date(lastSent).toLocaleString()}`
        : 'OneMorePlat: todavía no se ha enviado nada desde aquí.';
    }

    button.addEventListener('click', () => {
      const openedWindow = window.open(STORE_ENTRY_URL, '_blank');
      if (!openedWindow) {
        label.textContent =
          'OneMorePlat: el navegador ha bloqueado la ventana nueva -- permite pop-ups para steamcommunity.com e inténtalo otra vez.';
        return;
      }
      writeLastSentCookie();
      renderLabel();
    });

    renderLabel();
    panel.appendChild(label);
    panel.appendChild(button);

    const anchor = document.querySelector('.profile_header') || document.querySelector('.profile_page') || document.body;
    anchor.insertBefore(panel, anchor.firstChild);
  }

  if (location.hostname === 'store.steampowered.com') {
    void runOnStorePage();
  } else if (location.hostname === 'steamcommunity.com') {
    runOnProfilePage();
  }
})();
