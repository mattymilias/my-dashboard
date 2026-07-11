// src/index.js
//
// Single Cloudflare Worker handling everything:
// - Serves your static dashboard files (index.html, etc.) via the "assets" binding
// - Handles the /garmin-data API route with lazy-refresh caching in KV
//
// Required in wrangler.jsonc: assets directory + KV binding named GARMIN_KV
// Required environment variables (set as Worker secrets/vars): GARMIN_EMAIL, GARMIN_PASSWORD

import { GarminConnect } from 'garmin-connect';

const ONE_HOUR_MS = 60 * 60 * 1000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchFreshSnapshot(env) {
  const GCClient = new GarminConnect({
    username: env.GARMIN_EMAIL,
    password: env.GARMIN_PASSWORD,
  });

  await GCClient.login();

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const [sleep, userSummary, hrv] = await Promise.all([
    GCClient.getSleepData(isoDate(yesterday)).catch((e) => ({ error: e.message })),
    GCClient.getUserSummary(isoDate(today)).catch((e) => ({ error: e.message })),
    GCClient.getHeartRate?.(isoDate(today)).catch((e) => ({ error: e.message })) ?? null,
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    date: isoDate(today),
    sleep,
    userSummary,
    hrv,
  };
}

async function handleGarminData(env) {
  try {
    if (!env.GARMIN_EMAIL || !env.GARMIN_PASSWORD) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing GARMIN_EMAIL / GARMIN_PASSWORD' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    const cachedRaw = await env.GARMIN_KV.get('latest');
    const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
    const isStale = !cached || (Date.now() - new Date(cached.fetchedAt).getTime() > ONE_HOUR_MS);

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

    // Everything else falls through to the static files (index.html, css, etc.)
    return env.ASSETS.fetch(request);
  },
};
