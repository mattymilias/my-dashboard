// src/garminClient.js
//
// A minimal, Cloudflare Workers-compatible reimplementation of the Garmin Connect
// login flow (SSO handshake + OAuth1 HMAC-SHA1 signing + OAuth2 token exchange),
// using only fetch() and the Web Crypto API — no Node-only dependencies.
//
// Ported from the logic in the `garmin-connect` npm package's HttpClient.js,
// since that package itself can't run in Workers (it depends on Node's fs/crypto/app-root-path).

const DOMAIN = 'garmin.com';
const GC_MODERN = `https://connect.${DOMAIN}/modern`;
const GARMIN_SSO_ORIGIN = `https://sso.${DOMAIN}`;
const GARMIN_SSO = `${GARMIN_SSO_ORIGIN}/sso`;
const GARMIN_SSO_EMBED = `${GARMIN_SSO_ORIGIN}/sso/embed`;
const SIGNIN_URL = `${GARMIN_SSO}/signin`;
const GC_API = `https://connectapi.${DOMAIN}`;
const OAUTH_URL = `${GC_API}/oauth-service/oauth`;
const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

const USER_AGENT_CONNECTMOBILE = 'com.garmin.android.apps.connectmobile';
const USER_AGENT_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TICKET_RE = /ticket=([^"]+)"/;

// ---------- helpers ----------

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1Base64(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function oauth1SignedParams({ url, method, consumer, token }) {
  const [baseUrl, queryStr] = url.split('?');
  const queryParams = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const [k, v] = pair.split('=');
      queryParams[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }

  const oauthParams = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (token) oauthParams.oauth_token = token.key;

  const allParams = { ...queryParams, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&');

  const baseString = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(consumer.secret)}&${percentEncode(token ? token.secret : '')}`;
  const signature = await hmacSha1Base64(signingKey, baseString);

  const authParams = { ...oauthParams, oauth_signature: signature };
  return authParams;
}

function authHeaderFromParams(authParams) {
  const header =
    'OAuth ' +
    Object.keys(authParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(authParams[k])}"`)
      .join(', ');
  return header;
}

// Minimal cookie jar: merges Set-Cookie headers across requests in one login session.
function mergeCookies(jar, response) {
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const single = response.headers.get('set-cookie');
  const all = setCookies.length ? setCookies : single ? [single] : [];
  for (const c of all) {
    const [pair] = c.split(';');
    const [name, value] = pair.split('=');
    if (name) jar[name.trim()] = value;
  }
}
function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ---------- main login flow ----------

async function fetchOauthConsumer() {
  const res = await fetch(OAUTH_CONSUMER_URL);
  const data = await res.json();
  return { key: data.consumer_key, secret: data.consumer_secret };
}

async function getLoginTicket(username, password) {
  const jar = {};

  // Step 1: prime session
  const step1Url = `${GARMIN_SSO_EMBED}?${qs({ clientId: 'GarminConnect', locale: 'en', service: GC_MODERN })}`;
  const r1 = await fetch(step1Url, { headers: { 'User-Agent': USER_AGENT_BROWSER } });
  mergeCookies(jar, r1);
  await r1.text();

  // Step 2: get CSRF token
  const step2Url = `${SIGNIN_URL}?${qs({
    id: 'gauth-widget',
    embedWidget: 'true',
    locale: 'en',
    gauthHost: GARMIN_SSO_EMBED,
  })}`;
  const r2 = await fetch(step2Url, {
    headers: { 'User-Agent': USER_AGENT_BROWSER, Cookie: cookieHeader(jar) },
  });
  mergeCookies(jar, r2);
  const step2Html = await r2.text();
  const csrfMatch = CSRF_RE.exec(step2Html);
  if (!csrfMatch) throw new Error('Garmin login failed: CSRF token not found (SSO page layout may have changed)');
  const csrfToken = csrfMatch[1];

  // Step 3: submit credentials
  const signinParams = {
    id: 'gauth-widget',
    embedWidget: 'true',
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: GARMIN_SSO_EMBED,
    service: GARMIN_SSO_EMBED,
    source: GARMIN_SSO_EMBED,
    redirectAfterAccountLoginUrl: GARMIN_SSO_EMBED,
    redirectAfterAccountCreationUrl: GARMIN_SSO_EMBED,
  };
  const step3Url = `${SIGNIN_URL}?${qs(signinParams)}`;
  const formBody = qs({ username, password, embed: 'true', _csrf: csrfToken });

  const r3 = await fetch(step3Url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: GARMIN_SSO_ORIGIN,
      Referer: SIGNIN_URL,
      'User-Agent': USER_AGENT_BROWSER,
      Cookie: cookieHeader(jar),
    },
    body: formBody,
  });
  mergeCookies(jar, r3);
  const step3Html = await r3.text();

  if (/var statuss*=s*"[^"]*"/.test(step3Html)) {
    throw new Error('Garmin login failed: account appears locked. Log into the Garmin Connect website directly to unlock it.');
  }

  const ticketMatch = TICKET_RE.exec(step3Html);
  if (!ticketMatch) {
    throw new Error('Garmin login failed: invalid username/password, or MFA is enabled (MFA is not supported here).');
  }
  return ticketMatch[1];
}

async function getOauth1Token(ticket, consumer) {
  const params = { ticket, 'login-url': GARMIN_SSO_EMBED, 'accepts-mfa-tokens': 'true' };
  const url = `${OAUTH_URL}/preauthorized?${qs(params)}`;
  const authParams = await oauth1SignedParams({ url, method: 'GET', consumer });
  const res = await fetch(url, {
    headers: { Authorization: authHeaderFromParams(authParams), 'User-Agent': USER_AGENT_CONNECTMOBILE },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Garmin OAuth1 token request failed (${res.status}): ${text}`);

  const parsed = {};
  for (const pair of text.split('&')) {
    const [k, v] = pair.split('=');
    parsed[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  if (!parsed.oauth_token) throw new Error('Garmin OAuth1 token missing in response: ' + text);
  return { key: parsed.oauth_token, secret: parsed.oauth_token_secret };
}

async function exchangeForOauth2(oauth1Token, consumer) {
  const baseUrl = `${OAUTH_URL}/exchange/user/2.0`;
  const authParams = await oauth1SignedParams({ url: baseUrl, method: 'POST', consumer, token: oauth1Token });
  const url = `${baseUrl}?${qs(authParams)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT_CONNECTMOBILE, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Garmin OAuth2 exchange failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

/**
 * Logs into Garmin Connect and returns an OAuth2 access token usable as a Bearer token
 * against connectapi.garmin.com endpoints.
 */
export async function garminLogin(username, password) {
  const consumer = await fetchOauthConsumer();
  const ticket = await getLoginTicket(username, password);
  const oauth1Token = await getOauth1Token(ticket, consumer);
  const oauth2 = await exchangeForOauth2(oauth1Token, consumer);
  return oauth2.access_token;
}

/** Calls a connectapi.garmin.com GET endpoint with the given Bearer token. */
export async function garminGet(path, accessToken) {
  const res = await fetch(`${GC_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT_CONNECTMOBILE },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Garmin API request failed (${res.status}) for ${path}: ${text}`);
  }
  return res.json();
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
