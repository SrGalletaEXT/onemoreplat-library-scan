// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      4.2.0
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
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
 * owned appIds to OneMorePlat, which then checks each new one against Steam's own achievement
 * APIs before adding anything. The script's own job stops at reading and normalizing that
 * list; every actual verification happens server-side.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata (same-origin, no cross-origin
 *    trickery needed) and sends the result to OneMorePlat. Runs automatically on any store
 *    page load (silent; the server's own per-account cooldown means most loads are a no-op),
 *    and ALSO whenever a "Buscar juegos" click below opens the store this way.
 *  - steamcommunity.com profile pages: shows a small status panel with the last result, plus a
 *    "Buscar juegos" button. Clicking it opens the store front page in a new tab (marked with
 *    a URL flag so that tab knows to close itself once done) -- a real HTML page, deliberately
 *    NOT dynamicstore/userdata directly: that endpoint returns raw JSON, which some browsers
 *    render as a built-in JSON viewer instead of a normal document a userscript can reliably
 *    run on. The new tab's own script instance runs the same read-and-send logic above, and
 *    the panel here updates live via GM_addValueChangeListener the moment that happens (with a
 *    pop-up-blocked check and a timeout, so the button never gets stuck silently). Only ever
 *    shown on your OWN profile (compares the logged-in session's steamID against the profile
 *    being viewed) -- it never appears on anyone else's profile, and viewing someone else's
 *    profile never sends their data anywhere; the library read is always tied to your own
 *    session, never to whichever profile happens to be open.
 *
 * No setup needed beyond installing this -- your Steam ID alone identifies your OneMorePlat
 * account, same as it already does for any of Steam's own APIs.
 */

(function () {
  'use strict';

  const API_BASE = 'https://onemoreplat.games/api';
  const RESULT_KEY = 'onemoreplatLastScanResult';
  const DYNAMICSTORE_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
  // A real HTML page (not dynamicstore/userdata's raw JSON) for the "Buscar juegos" button to
  // open -- see the header comment for why. The query param is just a signal that tab reads
  // back below to know it should close itself once the scan finishes.
  const AUTO_CLOSE_PARAM = 'onemoreplat_scan';
  const STORE_ENTRY_URL = `https://store.steampowered.com/?${AUTO_CLOSE_PARAM}=1`;

  async function fetchOwnedAppIds() {
    const response = await fetch(DYNAMICSTORE_URL, { credentials: 'include' });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  function postLibraryScan(steamId, appIds) {
    // GM_xmlhttpRequest, not fetch: this is a cross-origin POST (store.steampowered.com ->
    // onemoreplat.games). A plain fetch would need CORS headers OneMorePlat's backend doesn't
    // send for arbitrary origins and doesn't need to -- GM_xmlhttpRequest isn't subject to the
    // page's CORS policy at all, it's the browser extension itself making the request.
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_BASE}/sync/library-scan`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ steamId, appIds }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (error) {
              reject(error);
            }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timed out'))
      });
    });
  }

  // The script's whole job: read the account's own appId list and normalize it (just "is this
  // actually an array of appIds"), then hand it off. No classification, no filtering by type,
  // no verification of any kind happens here -- that's all done server-side once it arrives.
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

    let pendingTimeoutId = null;

    function resetButton() {
      if (pendingTimeoutId) {
        clearTimeout(pendingTimeoutId);
        pendingTimeoutId = null;
      }
      button.disabled = false;
      button.textContent = 'Buscar juegos';
    }

    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Buscando…';
      label.textContent = 'OneMorePlat: abriendo Steam para leer tu biblioteca…';

      // A real HTML page (STORE_ENTRY_URL), not dynamicstore/userdata's raw JSON directly --
      // see the header comment. That tab's own script instance runs the real work and closes
      // itself when finished; this tab just waits for the result.
      const openedWindow = window.open(STORE_ENTRY_URL, '_blank');
      if (!openedWindow) {
        resetButton();
        label.textContent =
          'OneMorePlat: el navegador ha bloqueado la ventana nueva -- permite pop-ups para steamcommunity.com e inténtalo otra vez.';
        return;
      }

      // Comfortably above the server's own worst case (~10 appIds x ~2.5s each, see
      // SyncService.maxNewAppIdsPerLibraryScan) and still under nginx's own 60s upstream
      // timeout -- a real production run without this margin got mistaken for "stuck" while
      // the server was still genuinely working.
      pendingTimeoutId = setTimeout(() => {
        resetButton();
        label.textContent = 'OneMorePlat: no ha llegado respuesta a tiempo -- inténtalo de nuevo.';
      }, 45000);
    });

    GM_addValueChangeListener(RESULT_KEY, (_key, _oldValue, newValue) => {
      resetButton();
      try {
        label.textContent = `OneMorePlat: ${summarize(JSON.parse(newValue))}`;
      } catch (error) {
        label.textContent = 'OneMorePlat: no se pudo leer el último resultado.';
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
