// ==UserScript==
// @name         Factum Library Scan
// @namespace    https://github.com/SrGalletaEXT/factum-library-scan
// @version      1.0.0
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to Factum/OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      onemoreplat.games
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/SrGalletaEXT/factum-library-scan/main/factum-library-scan.user.js
// @downloadURL  https://raw.githubusercontent.com/SrGalletaEXT/factum-library-scan/main/factum-library-scan.user.js
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
 * owned appIds to Factum, which then checks each new one against Steam's own achievement APIs
 * before adding anything.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata (same-origin, your own session) and
 *    sends the result to Factum. Runs quietly; Factum's own per-account cooldown (a few hours)
 *    means most page loads are a no-op network-wise.
 *  - steamcommunity.com profile pages: shows a small status panel with the last result --
 *    but ONLY on your own profile (compares the logged-in session's steamID against the
 *    profile being viewed). It never appears on anyone else's profile, and viewing someone
 *    else's profile never sends their data anywhere -- the library read is always tied to
 *    your own session, never to whichever profile happens to be open.
 *
 * Setup: generate a token in Factum's Settings ("Sync via browser script"), then paste it in
 * when this script first asks (Tampermonkey menu > Factum Library Scan > "Set sync token" to
 * redo this later, e.g. after regenerating the token in Settings).
 */

(function () {
  'use strict';

  const API_BASE = 'https://onemoreplat.games/api';
  const TOKEN_KEY = 'factumSyncToken';
  const RESULT_KEY = 'factumLastScanResult';

  function getToken() {
    let token = GM_getValue(TOKEN_KEY, '');
    if (!token) {
      const entered = window.prompt(
        'Factum Library Scan: paste your sync token (Factum -> Settings -> "Sync via browser script").'
      );
      token = entered ? entered.trim() : '';
      if (token) {
        GM_setValue(TOKEN_KEY, token);
      }
    }
    return token || null;
  }

  function setToken() {
    const entered = window.prompt('Factum Library Scan: paste your sync token.');
    if (entered && entered.trim()) {
      GM_setValue(TOKEN_KEY, entered.trim());
      window.alert('Token saved.');
    }
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Set sync token', setToken);
  }

  function postLibraryScan(steamId, appIds, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_BASE}/sync/library-scan`,
        headers: {
          'Content-Type': 'application/json',
          'X-Factum-Sync-Token': token
        },
        data: JSON.stringify({ steamId, appIds }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (res.status === 401) {
            // Token is invalid/rotated -- clear it so the next run prompts for a fresh one
            // instead of silently failing forever.
            GM_setValue(TOKEN_KEY, '');
          }
          reject(new Error(`Factum library-scan request failed: HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('Factum library-scan request failed: network error')),
        ontimeout: () => reject(new Error('Factum library-scan request timed out'))
      });
    });
  }

  async function runOnStorePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }

    const token = getToken();
    if (!token) {
      return;
    }

    let data;
    try {
      const response = await fetch('https://store.steampowered.com/dynamicstore/userdata/', {
        credentials: 'include'
      });
      if (!response.ok) {
        return;
      }
      data = await response.json();
    } catch (error) {
      console.warn('[Factum Library Scan] could not read dynamicstore/userdata', error);
      return;
    }

    const appIds = Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
    if (appIds.length === 0) {
      return;
    }

    try {
      const result = await postLibraryScan(g_steamID, appIds, token);
      GM_setValue(RESULT_KEY, JSON.stringify(result));
    } catch (error) {
      console.warn('[Factum Library Scan]', error);
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

  function renderPanel(text) {
    const panel = document.createElement('div');
    panel.id = 'factum-library-scan-panel';
    panel.style.cssText =
      'background:#1b2838;color:#c7d5e0;padding:10px 14px;margin:10px 0;' +
      'border-radius:4px;font-size:13px;line-height:1.4;border:1px solid #2a475e;';
    panel.textContent = text;

    const anchor = document.querySelector('.profile_header') || document.querySelector('.profile_page') || document.body;
    anchor.insertBefore(panel, anchor.firstChild);
  }

  function runOnProfilePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }

    const profileOwnerSteamId = resolveProfileOwnerSteamId();
    if (!profileOwnerSteamId || profileOwnerSteamId !== g_steamID) {
      // Only ever shown on your OWN profile -- viewing someone else's never triggers this,
      // and never sends anything either (the store-page read above is what actually talks to
      // Factum, and that always uses your own logged-in session regardless of which profile
      // you're looking at).
      return;
    }

    const raw = GM_getValue(RESULT_KEY, '');
    if (!raw) {
      renderPanel('Factum: aún sin datos -- visita cualquier página de la tienda de Steam para sincronizar.');
      return;
    }

    let summary;
    try {
      const result = JSON.parse(raw);
      const newGames = result.newGames || [];
      if (newGames.length > 0) {
        const names = newGames.map((g) => g.name).join(', ');
        summary = `Factum: ${newGames.length} juego(s) nuevo(s) encontrado(s) -- ${names}`;
      } else {
        summary = `Factum: última comprobación sin novedades (${new Date(result.scannedAt).toLocaleString()})`;
      }
      if (result.pendingAppIds > 0) {
        summary += ` -- ${result.pendingAppIds} pendientes para la próxima pasada`;
      }
    } catch (error) {
      summary = 'Factum: no se pudo leer el último resultado.';
    }

    renderPanel(summary);
  }

  if (location.hostname === 'store.steampowered.com') {
    void runOnStorePage();
  } else if (location.hostname === 'steamcommunity.com') {
    runOnProfilePage();
  }
})();
