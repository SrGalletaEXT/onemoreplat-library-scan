// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      7.0.0
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
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
 * verification happens in the browser -- that's all server-side, on its own schedule.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata (same-origin) and sends the list.
 *    Runs automatically on any store page load (silent; the server's own per-account cooldown
 *    means most loads are a no-op).
 *  - steamcommunity.com profile pages: shows a small panel with a **"Buscar juegos"** button.
 *    Clicking it reads dynamicstore/userdata and sends the list right there, via
 *    GM_xmlhttpRequest (which isn't subject to the page's CORS policy, so this works even
 *    though the profile page is a different origin from store.steampowered.com -- no popup,
 *    no new tab, and the browser's own cookies for store.steampowered.com are sent along
 *    automatically, same as a same-origin request would). The button waits for OneMorePlat to
 *    actually confirm it received the list before showing success -- the panel's "last sent"
 *    time (kept in a plain cookie on this page, nothing read back from OneMorePlat's server)
 *    only updates once that confirmation arrives, not just because the button was clicked.
 *    Only ever shown on your OWN profile (compares the logged-in session's steamID against the
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

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timed out'))
      });
    });
  }

  // Plain fetch works here (same-origin, on store.steampowered.com); the profile-page button
  // below needs the GM_xmlhttpRequest version instead, since it runs cross-origin.
  async function fetchOwnedAppIdsSameOrigin() {
    const response = await fetch(DYNAMICSTORE_URL, { credentials: 'include' });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  // GM_xmlhttpRequest, not fetch: cross-origin (steamcommunity.com -> store.steampowered.com),
  // and carries the browser's real store.steampowered.com session cookies automatically --
  // the extension making the request isn't bound by the page's own CORS/same-origin policy.
  async function fetchOwnedAppIdsCrossOrigin() {
    const responseText = await gmRequest({ method: 'GET', url: DYNAMICSTORE_URL });
    const data = JSON.parse(responseText);
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  // GM_xmlhttpRequest, not fetch: this is a cross-origin POST (store.steampowered.com /
  // steamcommunity.com -> onemoreplat.games). A plain fetch would need CORS headers
  // OneMorePlat's backend doesn't send for arbitrary origins and doesn't need to.
  function queueLibraryScan(steamId, appIds) {
    return gmRequest({
      method: 'POST',
      url: `${API_BASE}/sync/library-scan`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ steamId, appIds })
    });
  }

  // The script's whole job: read the account's own appId list, normalize it (just "is this
  // actually an array of appIds"), and hand it off -- no classification, no filtering, no
  // verification happens here, that's all server-side from here.
  async function runOnStorePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }
    try {
      const appIds = await fetchOwnedAppIdsSameOrigin();
      if (appIds.length > 0) {
        await queueLibraryScan(g_steamID, appIds);
      }
    } catch (error) {
      console.warn('[OneMorePlat Library Scan]', error);
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
  // own server: this only ever records "OneMorePlat confirmed it received a list from this
  // page", nothing about what it did with it afterwards (that part really is server-side, on
  // its own schedule). Only ever written after queueLibraryScan resolves successfully -- never
  // optimistically on click, so it can't say "sent" when the request actually failed. 1 year
  // is just "keep it around", not a meaningful expiry.
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

    function renderIdleLabel() {
      const lastSent = readLastSentCookie();
      label.textContent = lastSent
        ? `OneMorePlat: último envío confirmado ${new Date(lastSent).toLocaleString()}`
        : 'OneMorePlat: todavía no se ha enviado nada desde aquí.';
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Buscando…';
      label.textContent = 'OneMorePlat: leyendo tu biblioteca de Steam…';

      try {
        const appIds = await fetchOwnedAppIdsCrossOrigin();
        if (appIds.length === 0) {
          label.textContent = 'OneMorePlat: no se ha podido leer tu biblioteca de Steam (¿sesión iniciada?).';
          return;
        }

        label.textContent = `OneMorePlat: enviando ${appIds.length} juego(s)…`;
        await queueLibraryScan(g_steamID, appIds);

        // Only written on confirmed success -- never optimistically on click.
        writeLastSentCookie();
        renderIdleLabel();
      } catch (error) {
        console.warn('[OneMorePlat Library Scan]', error);
        label.textContent = `OneMorePlat: el envío ha fallado (${error.message}) -- inténtalo de nuevo.`;
      } finally {
        button.disabled = false;
        button.textContent = 'Buscar juegos';
      }
    });

    renderIdleLabel();
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
