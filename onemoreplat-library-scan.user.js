// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      3.0.0
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_getValue
// @grant        GM_setValue
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
 * owned appIds to OneMorePlat, which then checks each new one against Steam's own achievement
 * APIs before adding anything.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata and sends the result to OneMorePlat
 *    automatically, in the background. The server's own per-account cooldown (a few hours)
 *    means most page loads are a no-op network-wise.
 *  - steamcommunity.com profile pages: shows a small status panel with the last result, plus a
 *    button to run it again right there (uses GM_xmlhttpRequest to reach
 *    store.steampowered.com cross-origin, since a profile page isn't on that domain) -- but
 *    ONLY on your own profile (compares the logged-in session's steamID against the profile
 *    being viewed). It never appears on anyone else's profile, and viewing someone else's
 *    profile never sends their data anywhere -- the library read is always tied to your own
 *    session, never to whichever profile happens to be open.
 *
 * No setup needed beyond installing this -- your Steam ID alone identifies your OneMorePlat
 * account, same as it already does for any of Steam's own APIs.
 */

(function () {
  'use strict';

  const API_BASE = 'https://onemoreplat.games/api';
  const RESULT_KEY = 'onemoreplatLastScanResult';

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timed out'))
      });
    });
  }

  async function fetchOwnedAppIds() {
    // GM_xmlhttpRequest, not fetch: this needs to work from steamcommunity.com too (the
    // profile page's "sync now" button), which is cross-origin to store.steampowered.com and
    // would be blocked by CORS on a plain fetch. GM_xmlhttpRequest isn't subject to that --
    // it's the browser extension itself making the request, carrying your existing Steam
    // session cookies same as a same-origin request would.
    const res = await gmRequest({ method: 'GET', url: 'https://store.steampowered.com/dynamicstore/userdata/' });
    const data = JSON.parse(res.responseText);
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  async function postLibraryScan(steamId, appIds) {
    const res = await gmRequest({
      method: 'POST',
      url: `${API_BASE}/sync/library-scan`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ steamId, appIds })
    });
    return JSON.parse(res.responseText);
  }

  // Shared by the automatic store-page run and the profile page's manual button -- one appId
  // read, one report, one place the result gets cached for the panel to show.
  async function performScan(steamId) {
    const appIds = await fetchOwnedAppIds();
    if (appIds.length === 0) {
      return null;
    }
    const result = await postLibraryScan(steamId, appIds);
    GM_setValue(RESULT_KEY, JSON.stringify(result));
    return result;
  }

  async function runOnStorePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }
    try {
      await performScan(g_steamID);
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

  function summarize(result) {
    const newGames = result.newGames || [];
    let summary;
    if (newGames.length > 0) {
      const names = newGames.map((g) => g.name).join(', ');
      summary = `${newGames.length} juego(s) nuevo(s) encontrado(s) -- ${names}`;
    } else {
      summary = `Última comprobación sin novedades (${new Date(result.scannedAt).toLocaleString()})`;
    }
    if (result.pendingAppIds > 0) {
      summary += ` -- ${result.pendingAppIds} pendientes para la próxima pasada`;
    }
    return summary;
  }

  function runOnProfilePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }

    const profileOwnerSteamId = resolveProfileOwnerSteamId();
    if (!profileOwnerSteamId || profileOwnerSteamId !== g_steamID) {
      // Only ever shown on your OWN profile -- viewing someone else's never triggers this,
      // and never sends anything either (the library read is always tied to your own logged-in
      // session, never to whichever profile you're looking at).
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
    button.textContent = 'Sincronizar ahora';
    button.style.cssText =
      'background:#2a475e;color:#c7d5e0;border:1px solid #66c0f4;border-radius:3px;' +
      'padding:5px 12px;font-size:12px;cursor:pointer;flex:0 0 auto;';

    function setLabelFromCache() {
      const raw = GM_getValue(RESULT_KEY, '');
      if (!raw) {
        label.textContent = 'OneMorePlat: aún sin datos.';
        return;
      }
      try {
        label.textContent = `OneMorePlat: ${summarize(JSON.parse(raw))}`;
      } catch (error) {
        label.textContent = 'OneMorePlat: no se pudo leer el último resultado.';
      }
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Sincronizando…';
      label.textContent = 'OneMorePlat: leyendo tu biblioteca de Steam…';
      try {
        const result = await performScan(g_steamID);
        label.textContent = result
          ? `OneMorePlat: ${summarize(result)}`
          : 'OneMorePlat: no se ha podido leer tu biblioteca de Steam.';
      } catch (error) {
        label.textContent = 'OneMorePlat: la sincronización ha fallado, inténtalo de nuevo.';
      } finally {
        button.disabled = false;
        button.textContent = 'Sincronizar ahora';
      }
    });

    setLabelFromCache();
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
