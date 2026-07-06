// netlify/functions/garmin-sync.js
//
// Scheduled function — runs automatically on the schedule set in netlify.toml.
// Logs into Garmin Connect (server-side only, credentials never touch the browser),
// pulls yesterday + today's health stats, and caches them in Netlify Blobs so the
// dashboard can read them instantly without hitting Garmin on every page load.
//
// Required environment variables (set in Netlify dashboard → Site settings → Environment variables):
//   GARMIN_EMAIL
//   GARMIN_PASSWORD

import pkg from 'garmin-connect';
const { GarminConnect } = pkg;
import { getStore } from '@netlify/blobs';

export const config = {
  schedule: '@hourly', // adjust to '0 */3 * * *' etc. if you want it less frequent
};

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async () => {
  const { GARMIN_EMAIL, GARMIN_PASSWORD } = process.env;

  if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
    console.error('Missing GARMIN_EMAIL / GARMIN_PASSWORD env vars');
    return new Response('Missing Garmin credentials', { status: 500 });
  }

  const GCClient = new GarminConnect({
    username: GARMIN_EMAIL,
    password: GARMIN_PASSWORD,
  });

  try {
    await GCClient.login();

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    // Pull the metrics that matter for a sprinter: sleep, HRV, RHR, body battery, training load/status.
    const [sleep, userSummary, hrv, trainingStatus] = await Promise.all([
      GCClient.getSleepData(isoDate(yesterday)).catch((e) => ({ error: e.message })),
      GCClient.getUserSummary(isoDate(today)).catch((e) => ({ error: e.message })),
      GCClient.getHeartRate?.(isoDate(today)).catch((e) => ({ error: e.message })) ?? null,
      GCClient.getTrainingStatusAggregated?.(isoDate(today)).catch((e) => ({ error: e.message })) ?? null,
    ]);

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      date: isoDate(today),
      sleep,
      userSummary,
      hrv,
      trainingStatus,
    };

    const store = getStore('garmin-cache');
    await store.setJSON('latest', snapshot);

    // Keep a short rolling history so the AI has trend context (last 14 snapshots).
    let history = [];
    try {
      history = (await store.get('history', { type: 'json' })) || [];
    } catch (e) {
      history = [];
    }
    history.push(snapshot);
    if (history.length > 14) history = history.slice(history.length - 14);
    await store.setJSON('history', history);

    return new Response(JSON.stringify({ ok: true, date: snapshot.date }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    console.error('Garmin sync failed:', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};
