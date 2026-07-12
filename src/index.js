// src/index.js
//
// Single Cloudflare Worker handling everything:
// - Serves your static dashboard files (index.html, etc.) via the "assets" binding
// - Handles the /garmin-data API route with lazy-refresh caching in KV
//
// Uses a hand-rolled Garmin Connect client (garminClient.js) since the `garmin-connect`
// npm package depends on Node-only APIs that don't run in the Workers runtime.
//
// Required in wrangler.jsonc: assets directory + KV binding named GARMIN_KV
// Required environment variables (Settings -> Variables and Secrets): GARMIN_EMAIL, GARMIN_PASSWORD
 
import { garminLogin, garminGet, isoDate } from './garminClient.js';
 
const ONE_HOUR_MS = 60 * 60 * 1000;
 
async function fetchFreshSnapshot(env) {
  const accessToken = await garminLogin(env.GARMIN_EMAIL, env.GARMIN_PASSWORD);
 
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const todayStr = isoDate(today);
  const yesterdayStr = isoDate(yesterday);
 
  // Need the account's displayName first — the daily summary endpoint is keyed by it.
  const profile = await garminGet('/userprofile-service/socialProfile', accessToken).catch((e) => ({
    error: e.message,
  }));
  const displayName = profile?.displayName;
 
  const [sleep, userSummary, heartRate] = await Promise.all([
    garminGet(`/sleep-service/sleep/dailySleepData?date=${yesterdayStr}`, accessToken).catch((e) => ({
      error: e.message,
    })),
    displayName
      ? garminGet(`/usersummary-service/usersummary/daily/${displayName}?calendarDate=${todayStr}`, accessToken).catch(
          (e) => ({ error: e.message })
        )
      : { error: 'No displayName from profile' },
    garminGet(`/wellness-service/wellness/dailyHeartRate?date=${todayStr}`, accessToken).catch((e) => ({
      error: e.message,
    })),
  ]);
 
  return {
    fetchedAt: new Date().toISOString(),
    date: todayStr,
    sleep,
    userSummary,
    heartRate,
  };
}
 
async function handleGarminData(env) {
  try {
    if (!env.GARMIN_EMAIL || !env.GARMIN_PASSWORD) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Missing credentials',
          debug: {
            hasEmail: Boolean(env.GARMIN_EMAIL),
            hasPassword: Boolean(env.GARMIN_PASSWORD),
            envKeys: Object.keys(env || {}),
          },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
 
    const cachedRaw = await env.GARMIN_KV.get('latest');
    const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
    const isStale = !cached || Date.now() - new Date(cached.fetchedAt).getTime() > ONE_HOUR_MS;
 
    if (!isStale) {
      return new Response(JSON.stringify({ ok: true, latest: cached, fromCache: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
 
    try {
      const fresh = await fetchFreshSnapshot(env);
      await env.GARMIN_KV.put('latest', JSON.stringify(fresh));
 
      const historyRaw = await env.GARMIN_KV.get('history');
      let history = historyRaw ? JSON.parse(historyRaw) : [];
      history.push(fresh);
      if (history.length > 14) history = history.slice(history.length - 14);
      await env.GARMIN_KV.put('history', JSON.stringify(history));
 
      return new Response(JSON.stringify({ ok: true, latest: fresh, fromCache: false }), {
        headers: { 'content-type': 'application/json' },
      });
    } catch (refreshError) {
      if (cached) {
        return new Response(
          JSON.stringify({ ok: true, latest: cached, fromCache: true, refreshError: refreshError.message }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: false, error: refreshError.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
 
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
 
    if (url.pathname === '/garmin-data') {
      return handleGarminData(env);
    }
 
    return env.ASSETS.fetch(request);
  },
};
