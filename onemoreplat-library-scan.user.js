// ==UserScript==
// @name         OneMorePlat Library Scan
// @namespace    https://github.com/SrGalletaEXT/onemoreplat-library-scan
// @version      8.1.1
// @description  Reports your own Steam library (delisted, family-shared, and never-launched free games GetOwnedGames misses) to OneMorePlat -- reads only your own logged-in browser session, no third-party data.
// @author       SrGalletaEXT
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/id/*/*
// @match        https://steamcommunity.com/profiles/*/*
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @connect      api.steampowered.com
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
 * owned appIds to OneMorePlat.
 *
 * Family-shared games are a SEPARATE gap this also closes (v8): a game someone else in your
 * Steam Family Group shared with you never appears in rgOwnedApps or GetOwnedGames at all --
 * you don't hold a license for it, you're just allowed to launch it. Confirmed for real: a
 * OneMorePlat user's genuine, real achievement progress in a family-shared game was completely
 * invisible to every sync path until fixed by hand. This script resolves your own Family Group
 * (IFamilyGroupsService, using a short-lived access token Steam's own store front-end already
 * hands your logged-in session -- the same kind of token the store page itself uses for its own
 * features, not a login credential) and reports which shared appIds aren't apps you own
 * outright. The script's own job stops right there in both cases: no classification, no
 * verification happens in the browser -- OneMorePlat's backend independently checks
 * GetPlayerAchievements for every family-shared appId before ever adding it, since being shared
 * into the group is not proof you've actually played it.
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
 *  - Family Group sharing is checked from BOTH entry points above, right alongside the
 *    rgOwnedApps read -- same silence/same button, no separate step for you to run. If it
 *    fails for any reason (no Family Group, Steam changed the endpoint, anything) it's caught
 *    and logged to the console, never blocking the rest of the report -- rgOwnedApps still
 *    gets sent either way.
 *  - Below that button, a second row (v8.1) is a manual, last-resort appId box: paste a
 *    comma-separated list of Steam appIds you've found some other way (e.g. by hand-comparing
 *    against another tracker) and they're queued the exact same way as everything else this
 *    script sends -- same endpoint, same job pipeline, same server-side GetPlayerAchievements
 *    verification before anything is added. This box makes NO calls anywhere except
 *    OneMorePlat's own API; it never talks to any other tracker's site, and it's entirely
 *    separate from any other comparison tool you might run by hand elsewhere.
 *
 * No setup needed beyond installing this -- your Steam ID alone identifies your OneMorePlat
 * account, same as it already does for any of Steam's own APIs.
 */

(function () {
  'use strict';

  const API_BASE = 'https://onemoreplat.games/api';
  const DYNAMICSTORE_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
  const ASYNC_CONFIG_URL = 'https://store.steampowered.com/pointssummary/ajaxgetasyncconfig';
  const FAMILY_GROUP_URL = 'https://api.steampowered.com/IFamilyGroupsService/GetFamilyGroupForUser/v1/';
  const SHARED_LIBRARY_URL = 'https://api.steampowered.com/IFamilyGroupsService/GetSharedLibraryApps/v1/';
  const LAST_SENT_COOKIE = 'onemoreplat_last_sent';
  const LOG_PREFIX = '[OneMorePlat Library Scan]';

  // Plain console.log throughout the Family Group chain (new, less-proven than the rest of
  // this script) -- deliberately verbose so testing this for the first time against a real
  // account just means "open the console, reload/click, read what happened", instead of
  // having to decode GM_xmlhttpRequest responses out of the Network tab by hand.
  function debugLog(...args) {
    console.log(LOG_PREFIX, ...args);
  }

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

  // Always GM_xmlhttpRequest, not fetch, regardless of which page this runs from --
  // api.steampowered.com is never same-origin with either store.steampowered.com or
  // steamcommunity.com, unlike dynamicstore/userdata above (same-origin on the store page
  // only). Cookies for store.steampowered.com still ride along automatically (needed for the
  // token step, which reads the logged-in session the same way dynamicstore/userdata does).
  //
  // fetchFamilySharedAppIds is deliberately best-effort: ANY failure along this whole chain
  // (token request, family group lookup, shared-library call, or an unexpected response
  // shape) resolves to an empty list and logs a warning, instead of throwing -- rgOwnedApps
  // reporting must never be blocked by this newer, less-proven feature.
  async function fetchFamilySharedAppIds(mySteamId) {
    try {
      debugLog('Family Group check: requesting webapi_token...');
      const token = await fetchWebApiToken();
      if (!token) {
        debugLog('Family Group check: no webapi_token in the response, stopping here (see the raw response logged above).');
        return [];
      }
      debugLog('Family Group check: got a webapi_token.');

      // resolveFamilyGroupId always resolves to SOME value (falling back to the literal
      // '0' -- see its own comment) rather than ever giving up outright: an account with no
      // Family Group at all should just get an empty apps list back from the call below,
      // same end result as stopping here early would have given, but tried for real instead
      // of assumed.
      const familyGroupId = await resolveFamilyGroupId(token);
      debugLog('Family Group check: using family_groupid =', familyGroupId);

      const sharedAppIds = await fetchSharedLibraryAppIds(token, familyGroupId, mySteamId);
      debugLog('Family Group check: shared-but-not-owned appIds found =', sharedAppIds);
      return sharedAppIds;
    } catch (error) {
      console.warn(`${LOG_PREFIX} family-sharing check failed, skipping:`, error);
      return [];
    }
  }

  // Same trick Steam's own store front-end uses for its client-side-authenticated features
  // (loyalty points, etc.): this endpoint hands back a short-lived access token for whoever's
  // logged-in session called it, usable as ?access_token=... on api.steampowered.com calls in
  // place of a server-side API key. Nothing about this is a login credential -- it can't do
  // anything your browser's own existing session couldn't already do, and it's never sent
  // anywhere but back to Steam's own API.
  async function fetchWebApiToken() {
    const responseText = await gmRequest({
      method: 'GET',
      url: ASYNC_CONFIG_URL,
      headers: { Accept: 'application/json' }
    });
    const data = JSON.parse(responseText);
    if (!data || !data.success || !data.data || !data.data.webapi_token) {
      debugLog('ajaxgetasyncconfig raw response (no webapi_token found in it):', data);
    }
    return data && data.success && data.data && data.data.webapi_token ? data.data.webapi_token : null;
  }

  // GetFamilyGroupForUser's steamid param is only for support/admin accounts looking up
  // someone else's group -- omitted here on purpose, letting it resolve for whoever the
  // access_token itself identifies (i.e. us). include_family_group_response=true asks for the
  // group id itself, not just a yes/no membership flag.
  //
  // NOTE for whoever reads this later: the exact response field name for the group id was not
  // verified against a real, live logged-in session before this shipped (no live browser
  // session was available while writing it) -- family_groupid is the most likely name (matches
  // every other IFamilyGroupsService param/response using that name), but if this keeps
  // returning [] for an account you KNOW has an active Family Group, open the Network tab for
  // this request and check the real response shape first.
  async function resolveFamilyGroupId(token) {
    try {
      const params = new URLSearchParams({ access_token: token, include_family_group_response: 'true' });
      const responseText = await gmRequest({ method: 'GET', url: `${FAMILY_GROUP_URL}?${params.toString()}` });
      const data = JSON.parse(responseText);
      debugLog('GetFamilyGroupForUser raw response:', data);
      const groupId = data && data.response && data.response.family_groupid;
      if (groupId) {
        return String(groupId);
      }
      debugLog('GetFamilyGroupForUser: no family_groupid in the response above -- falling back to family_groupid=0.');
    } catch (error) {
      console.warn(`${LOG_PREFIX} GetFamilyGroupForUser failed:`, error);
    }

    // Fallback: family_groupid=0 as a literal value is undocumented but reportedly tolerated
    // by Steam for the common case of belonging to exactly one Family Group -- worth trying
    // before giving up entirely, since the proper lookup above needs a working, correctly-
    // shaped GetFamilyGroupForUser response to succeed at all.
    return '0';
  }

  async function fetchSharedLibraryAppIds(token, familyGroupId, mySteamId) {
    const params = new URLSearchParams({
      access_token: token,
      family_groupid: familyGroupId,
      include_own: 'true',
      include_excluded: 'true',
      include_free: 'true',
      include_non_games: 'true'
    });
    const responseText = await gmRequest({
      method: 'GET',
      url: `${SHARED_LIBRARY_URL}?${params.toString()}`
    });
    const data = JSON.parse(responseText);
    debugLog('GetSharedLibraryApps raw response:', data);
    const apps = data && data.response && Array.isArray(data.response.apps) ? data.response.apps : [];

    const mySteamIdStr = String(mySteamId);
    const sharedAppIds = [];
    for (const app of apps) {
      const owners = Array.isArray(app.owner_steamids) ? app.owner_steamids.map(String) : [];
      // Only apps we DON'T own a license for ourselves, and that aren't sharing-restricted
      // (exclude_reason 0 = no restriction) -- matches "someone else shared this with me".
      if (!owners.includes(mySteamIdStr) && app.exclude_reason === 0) {
        sharedAppIds.push(app.appid);
      }
    }
    return sharedAppIds;
  }

  // GM_xmlhttpRequest, not fetch: this is a cross-origin POST (store.steampowered.com /
  // steamcommunity.com -> onemoreplat.games). A plain fetch would need CORS headers
  // OneMorePlat's backend doesn't send for arbitrary origins and doesn't need to.
  //
  // manualAppIds (v8.1): appIds the user typed in by hand into the profile-page box below,
  // instead of ones this script discovered on its own. Sent through this exact same call --
  // same endpoint, same steamId identification -- so the backend can route them through the
  // normal job pipeline (GetPlayerAchievements verification, then a real recalculation of the
  // account's stats) rather than being some separate one-off path.
  function queueLibraryScan(steamId, appIds, familySharedAppIds, manualAppIds) {
    debugLog(
      `sending ${appIds.length} owned appId(s), ${familySharedAppIds.length} family-shared appId(s), ` +
        `and ${manualAppIds.length} manually-entered appId(s) to OneMorePlat:`,
      { appIds, familySharedAppIds, manualAppIds }
    );
    return gmRequest({
      method: 'POST',
      url: `${API_BASE}/sync/library-scan`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ steamId, appIds, familySharedAppIds, manualAppIds })
    });
  }

  // The script's whole job: read the account's own appId list plus its Family Group's shared
  // one, normalize both (just "is this actually an array of appIds"), and hand them off -- no
  // classification, no filtering, no verification happens here, that's all server-side from
  // here.
  async function runOnStorePage() {
    if (typeof g_steamID === 'undefined' || !g_steamID) {
      return; // not logged in
    }
    try {
      const [appIds, familySharedAppIds] = await Promise.all([
        fetchOwnedAppIdsSameOrigin(),
        fetchFamilySharedAppIds(g_steamID)
      ]);
      if (appIds.length > 0 || familySharedAppIds.length > 0) {
        await queueLibraryScan(g_steamID, appIds, familySharedAppIds, []);
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
      'border-radius:4px;font-size:13px;line-height:1.4;border:1px solid #2a475e;';

    const scanRow = document.createElement('div');
    scanRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';

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
        const [appIds, familySharedAppIds] = await Promise.all([
          fetchOwnedAppIdsCrossOrigin(),
          fetchFamilySharedAppIds(g_steamID)
        ]);
        if (appIds.length === 0 && familySharedAppIds.length === 0) {
          label.textContent = 'OneMorePlat: no se ha podido leer tu biblioteca de Steam (¿sesión iniciada?).';
          return;
        }

        label.textContent = `OneMorePlat: enviando ${appIds.length} juego(s)…`;
        await queueLibraryScan(g_steamID, appIds, familySharedAppIds, []);

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
    scanRow.appendChild(label);
    scanRow.appendChild(button);
    panel.appendChild(scanRow);

    // --- Manual, last-resort appId entry (v8.1) ---------------------------------------------
    // Collapsed by default via a plain <details> -- this is a rare-case option, not something
    // that needs to sit open and take up space every time someone loads their profile. Its own
    // border-top doubles as the thin divider from the automatic scan above, open or not.
    // Submitting goes through the exact same queueLibraryScan call as everything else in this
    // script -- same endpoint, same job pipeline, same server-side achievement verification --
    // it never talks to any other site.
    const manualDetails = document.createElement('details');
    manualDetails.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #2a475e;';

    const manualSummary = document.createElement('summary');
    manualSummary.textContent = 'Añadir appId manualmente (último recurso)';
    manualSummary.style.cssText = 'cursor:pointer;color:#8f98a0;font-size:12px;font-weight:600;';
    manualDetails.appendChild(manualSummary);

    const manualBody = document.createElement('div');
    manualBody.style.cssText = 'margin-top:8px;';
    manualDetails.appendChild(manualBody);

    const manualHint = document.createElement('div');
    manualHint.style.cssText = 'font-size:12px;color:#8f98a0;margin-bottom:6px;';
    manualHint.textContent =
      'Último recurso: si conoces algún appId de Steam que el escaneo automático no haya encontrado, ' +
      'añádelo aquí a mano (separado por comas).';

    const manualRow = document.createElement('div');
    manualRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

    const manualInput = document.createElement('input');
    manualInput.type = 'text';
    manualInput.placeholder = 'p. ej. 252850,261820,427270';
    manualInput.style.cssText =
      'flex:1 1 240px;background:#0f1720;color:#c7d5e0;border:1px solid #2a475e;' +
      'border-radius:3px;padding:5px 8px;font-size:12px;';

    const manualButton = document.createElement('button');
    manualButton.textContent = 'Añadir por ID';
    manualButton.style.cssText =
      'background:#2a475e;color:#c7d5e0;border:1px solid #66c0f4;border-radius:3px;' +
      'padding:5px 12px;font-size:12px;cursor:pointer;flex:0 0 auto;';

    const manualStatus = document.createElement('div');
    manualStatus.style.cssText = 'flex:1 1 100%;font-size:12px;color:#c7d5e0;min-height:16px;margin-top:4px;';

    // Same parsing style as the appIds pasted into chat during testing: comma-separated,
    // whitespace tolerated, non-numeric/duplicate/non-positive entries dropped rather than
    // rejecting the whole submission -- the backend re-validates/dedupes independently anyway
    // (see processLibraryScan's candidateManualAppIds handling), this is just so obviously bad
    // input doesn't even leave the browser.
    function parseManualAppIds(rawText) {
      const seen = new Set();
      for (const piece of rawText.split(',')) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const id = Number(trimmed);
        if (Number.isInteger(id) && id > 0) {
          seen.add(id);
        }
      }
      return Array.from(seen);
    }

    manualButton.addEventListener('click', async () => {
      const manualAppIds = parseManualAppIds(manualInput.value);
      if (manualAppIds.length === 0) {
        manualStatus.textContent = 'Escribe al menos un appId numérico válido, separado por comas.';
        return;
      }

      manualButton.disabled = true;
      manualButton.textContent = 'Añadiendo…';
      manualStatus.textContent = `OneMorePlat: enviando ${manualAppIds.length} appId(s)…`;

      try {
        // No automatic discovery here -- appIds/familySharedAppIds are empty on purpose, this
        // submission is ONLY the manual list. A normal sync still runs on the backend for
        // these (GetPlayerAchievements verification, then recalculateUserCompetitiveStats),
        // same as any other discovery path -- see processAchievementVerifiedAppIds.
        await queueLibraryScan(g_steamID, [], [], manualAppIds);
        manualStatus.textContent =
          `OneMorePlat: ${manualAppIds.length} appId(s) enviado(s). Se comprobarán y se añadirán ` +
          'los que de verdad tengan progreso de logros.';
        manualInput.value = '';
      } catch (error) {
        console.warn('[OneMorePlat Library Scan]', error);
        manualStatus.textContent = `OneMorePlat: el envío ha fallado (${error.message}) -- inténtalo de nuevo.`;
      } finally {
        manualButton.disabled = false;
        manualButton.textContent = 'Añadir por ID';
      }
    });

    manualRow.appendChild(manualInput);
    manualRow.appendChild(manualButton);
    manualBody.appendChild(manualHint);
    manualBody.appendChild(manualRow);
    manualBody.appendChild(manualStatus);
    panel.appendChild(manualDetails);

    const anchor = document.querySelector('.profile_header') || document.querySelector('.profile_page') || document.body;
    anchor.insertBefore(panel, anchor.firstChild);
  }

  if (location.hostname === 'store.steampowered.com') {
    void runOnStorePage();
  } else if (location.hostname === 'steamcommunity.com') {
    runOnProfilePage();
  }
})();
