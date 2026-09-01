// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      5.0.0
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
 * owned appIds to OneMorePlat, which then checks each new one against Steam's own achievement
 * APIs before adding anything. The script's own job stops at reading and normalizing that
 * list; every actual verification (and all of the real work) happens server-side, in its own
 * time -- OneMorePlat just queues the list, it does not process it while this script waits.
 *
 * Where it runs:
 *  - store.steampowered.com: reads dynamicstore/userdata (same-origin, no cross-origin
 *    trickery needed) and sends the list to OneMorePlat, which queues it for its own
 *    background worker -- the response here just confirms it was queued (or, if OneMorePlat
 *    scanned recently enough already, echoes that previous result back). Runs automatically
 *    on any store page load (silent; the server's own per-account cooldown means most loads
 *    are a no-op), and ALSO whenever a "Buscar juegos" click below opens the store this way.
 *  - steamcommunity.com profile pages: shows a small status panel with the last COMPLETED
 *    scan (fetched fresh on every page load -- there's no live progress to show, a scan can
 *    take anywhere from seconds to a while depending on how much is new), plus a "Buscar
 *    juegos" button. Clicking it opens the store front page in a new tab (a real HTML page,
 *    deliberately NOT dynamicstore/userdata directly: that endpoint returns raw JSON, which
 *    some browsers render as a built-in JSON viewer instead of a normal document a userscript
 *    can reliably run on) tagged with a URL flag so that tab closes itself once it's sent the
 *    list. The panel then checks back a few times over the next couple of minutes in case the
 *    scan finishes quickly; if it's still not done by then, it just says so -- checking this
 *    page again later will show it once it's ready, same as it would on any other page load.
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
  // A real HTML page (not dynamicstore/userdata's raw JSON) for the "Buscar juegos" button to
  // open -- see the header comment for why. The query param is just a signal that tab reads
  // back below to know it should close itself once it's sent the list.
  const AUTO_CLOSE_PARAM = 'onemoreplat_scan';
  const STORE_ENTRY_URL = `https://store.steampowered.com/?${AUTO_CLOSE_PARAM}=1`;

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(res.responseText ? JSON.parse(res.responseText) : null);
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

  async function fetchOwnedAppIds() {
    const response = await fetch(DYNAMICSTORE_URL, { credentials: 'include' });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
  }

  // GM_xmlhttpRequest, not fetch: this is a cross-origin request (store.steampowered.com /
  // steamcommunity.com -> onemoreplat.games). A plain fetch would need CORS headers
  // OneMorePlat's backend doesn't send for arbitrary origins and doesn't need to --
  // GM_xmlhttpRequest isn't subject to the page's CORS policy at all, it's the browser
  // extension itself making the request.
  function queueLibraryScan(steamId, appIds) {
    return gmRequest({
      method: 'POST',
      url: `${API_BASE}/sync/library-scan`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ steamId, appIds })
    });
  }

  function fetchLibraryScanStatus(steamId) {
    return gmRequest({
      method: 'GET',
      url: `${API_BASE}/sync/library-scan/status?steamId=${encodeURIComponent(steamId)}`
    });
  }

  // The script's whole job: read the account's own appId list, normalize it (just "is this
  // actually an array of appIds"), and hand it off. No classification, no filtering by type,
  // no verification of any kind happens here -- and no waiting around for it to be processed
  // either, that's all server-side, on its own schedule.
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

  function summarize(result) {
    if (!result) {
      return 'aún sin datos.';
    }
    const newGames = result.newGames || [];
    if (newGames.length > 0) {
      const names = newGames.map((g) => g.name).join(', ');
      return `${newGames.length} juego(s) nuevo(s) encontrado(s) -- ${names}`;
    }
    return `Última comprobación sin novedades (${new Date(result.scannedAt).toLocaleString()})`;
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
    label.textContent = 'OneMorePlat: comprobando…';
    const button = document.createElement('button');
    button.textContent = 'Buscar juegos';
    button.style.cssText =
      'background:#2a475e;color:#c7d5e0;border:1px solid #66c0f4;border-radius:3px;' +
      'padding:5px 12px;font-size:12px;cursor:pointer;flex:0 0 auto;';

    let lastKnownScannedAt = null;

    async function refreshLabel() {
      try {
        const result = await fetchLibraryScanStatus(g_steamID);
        lastKnownScannedAt = result ? result.scannedAt : lastKnownScannedAt;
        label.textContent = `OneMorePlat: ${summarize(result)}`;
        return result;
      } catch (error) {
        label.textContent = 'OneMorePlat: no se pudo comprobar el estado.';
        return null;
      }
    }

    // After requesting a scan, check back a few times over ~2 minutes in case it finishes
    // quickly -- stops the moment scannedAt moves past whatever it was before the click. If it
    // still hasn't by the last check, this just says so; the next normal page load will show
    // the real result whenever it's actually ready, no different from checking back later.
    async function pollForCompletion() {
      const checkTimes = [10000, 20000, 30000, 45000, 60000, 90000, 120000];
      const startedWithScannedAt = lastKnownScannedAt;

      for (const delay of checkTimes) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const result = await refreshLabel();
        if (result && result.scannedAt !== startedWithScannedAt) {
          button.disabled = false;
          button.textContent = 'Buscar juegos';
          return;
        }
      }

      button.disabled = false;
      button.textContent = 'Buscar juegos';
      label.textContent = 'OneMorePlat: escaneo en curso todavía -- vuelve a mirar esta página más tarde.';
    }

    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Buscando…';
      label.textContent = 'OneMorePlat: abriendo Steam para leer tu biblioteca…';

      const openedWindow = window.open(STORE_ENTRY_URL, '_blank');
      if (!openedWindow) {
        button.disabled = false;
        button.textContent = 'Buscar juegos';
        label.textContent =
          'OneMorePlat: el navegador ha bloqueado la ventana nueva -- permite pop-ups para steamcommunity.com e inténtalo otra vez.';
        return;
      }

      void pollForCompletion();
    });

    panel.appendChild(label);
    panel.appendChild(button);

    const anchor = document.querySelector('.profile_header') || document.querySelector('.profile_page') || document.body;
    anchor.insertBefore(panel, anchor.firstChild);

    void refreshLabel();
  }

  if (location.hostname === 'store.steampowered.com') {
    void runOnStorePage();
  } else if (location.hostname === 'steamcommunity.com') {
    runOnProfilePage();
  }
})();
