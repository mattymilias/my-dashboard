// netlify/functions/garmin-data.js
//
// Frontend calls: GET /.netlify/functions/garmin-data
// Returns the latest cached Garmin snapshot (and short history) written by garmin-sync.js.
// This is deliberately read-only and fast — no live Garmin calls happen here.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('garmin-cache');

  const url = new URL(req.url);
  const wantHistory = url.searchParams.get('history') === '1';

  try {
    const latest = (await store.get('latest', { type: 'json' })) || null;
    const history = wantHistory ? (await store.get('history', { type: 'json' })) || [] : undefined;

    if (!latest) {
      return new Response(
        JSON.stringify({ ok: false, message: 'No Garmin data cached yet — first sync may still be running.' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: true, latest, history }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};
