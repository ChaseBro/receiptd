// Star CloudPRNT Version MQTT, "Trigger POST" mode — see docs/cloudprnt-mqtt.md.
//
// Two halves, both optional and both fail-open to plain HTTP polling:
//
//  1. serverSetting(): the body of `GET <folder of Server URL>/cloudprnt-setting.json`
//     ("Server setting information request"). A firmware ≥2.2 TSP100IV asks for
//     it at boot and periodically; a 200 + valid JSON switches it to MQTT
//     Trigger POST, anything else (404) keeps it on CloudPRNT HTTP.
//  2. triggerPrinterPoll(): publish `{"title":"request-post"}` on
//     `star/cloudprnt/to-device/<mac>/request-post` through EMQX Serverless's
//     REST publish API. The printer reacts with an immediate POST poll to the
//     same /cprnt/<id> endpoint, so the rest of the job flow is unchanged.
//
// No print data goes through the broker. Every function here is self-contained
// (no imports) so it can be unit-tested with plain `node --test`.

export type MqttEnv = {
  /** EMQX Serverless REST base, as shown in the console, e.g.
   *  "https://abc123.ala.us-east-1.emqxsl.com:8443/api/v5". A trailing
   *  "/publish" or "/" is tolerated. */
  MQTT_API_URL?: string;
  /** Deployment API Key "App ID" (HTTP Basic user). Secret. */
  MQTT_APP_KEY?: string;
  /** Deployment API Key "App Secret" (HTTP Basic password). Secret. */
  MQTT_APP_SECRET?: string;
  /** MQTT broker host the printer dials. Defaults to MQTT_API_URL's hostname. */
  MQTT_BROKER_HOST?: string;
  /** MQTT-over-TLS port. Default "8883" (Serverless only offers TLS). */
  MQTT_BROKER_PORT?: string;
  /** Broker username/password for the printer (EMQX "Authentication" entry). Secret. */
  MQTT_PRINTER_USERNAME?: string;
  MQTT_PRINTER_PASSWORD?: string;
  /** Safety-net POST poll interval while in Trigger POST mode. Default "30".
   *  Without it the printer stops periodic polling entirely, so a lost
   *  trigger would strand a job until the next one. */
  MQTT_FALLBACK_POLL_SEC?: string;
  /** Printer re-reads cloudprnt-setting.json every N minutes (default 1440 = daily). */
  MQTT_SETTINGS_RELOAD_MIN?: string;
  /** Kill switch: "0"/"false"/"off" serves 404 (HTTP-only) and no-ops triggers. */
  MQTT_ENABLED?: string;
};

export const TOPIC_PREFIX_TO_DEVICE = "star/cloudprnt/to-device";
export const TOPIC_PREFIX_TO_SERVER = "star/cloudprnt/to-server";
export const DEFAULT_TIMEOUT_MS = 2500;

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** Normalise a printer MAC to the lowercase, colon-separated form Star's
 *  samples use in topics ("00:11:62:5a:a9:8b"). Accepts -, :, . or no
 *  separators. Returns null if it isn't a 48-bit MAC. */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (typeof mac !== "string") return null;
  const hex = mac.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  const out = hex.match(/../g)!.join(":");
  return MAC_RE.test(out) ? out : null;
}

/** `star/cloudprnt/to-device/<mac>/<method>` */
export function deviceTopic(mac: string, method: string): string {
  const m = normalizeMac(mac);
  if (!m) throw new Error(`invalid printer MAC: ${JSON.stringify(mac)}`);
  if (!/^[a-z-]+$/.test(method)) throw new Error(`invalid method: ${JSON.stringify(method)}`);
  return `${TOPIC_PREFIX_TO_DEVICE}/${m}/${method}`;
}

/** EMQX REST publish body for a Trigger POST nudge. QoS 1 so the broker
 *  retries delivery over a flaky printer link; never retained (a retained
 *  trigger would just cause a pointless poll on every reconnect). */
export function buildTriggerPublish(mac: string): {
  topic: string;
  payload: string;
  payload_encoding: "plain";
  qos: 0 | 1;
  retain: false;
} {
  return {
    topic: deviceTopic(mac, "request-post"),
    payload: JSON.stringify({ title: "request-post" }),
    payload_encoding: "plain",
    qos: 1,
    retain: false,
  };
}

/** Resolve MQTT_API_URL to the publish endpoint. */
export function publishUrl(apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/publish")) return base;
  return `${base}/publish`;
}

function isOff(v: string | undefined): boolean {
  return v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
}

export function publisherConfigured(env: MqttEnv): boolean {
  return !isOff(env.MQTT_ENABLED) && !!env.MQTT_API_URL && !!env.MQTT_APP_KEY && !!env.MQTT_APP_SECRET;
}

export type TriggerResult =
  | { ok: true; status: number; delivered: boolean }
  | { ok: false; reason: string };

/**
 * Ask the printer to poll now. Never throws and never takes longer than
 * `timeoutMs`; callers should still run it under `ctx.waitUntil` so the
 * enqueue response isn't held up. On any failure the printer picks the job
 * up on its next fallback poll.
 *
 * `delivered: false` means EMQX accepted the publish but answered 202
 * `no_matching_subscribers` — i.e. the printer isn't connected to the broker
 * (offline, or still in HTTP mode).
 */
export async function triggerPrinterPoll(
  env: MqttEnv,
  mac: string | null | undefined,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TriggerResult> {
  try {
    if (!publisherConfigured(env)) return { ok: false, reason: "mqtt not configured" };
    const m = normalizeMac(mac);
    if (!m) return { ok: false, reason: "no printer MAC" };

    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(publishUrl(env.MQTT_API_URL!), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${env.MQTT_APP_KEY}:${env.MQTT_APP_SECRET}`),
      },
      body: JSON.stringify(buildTriggerPublish(m)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused; content is advisory.
    const text = await res.text().catch(() => "");
    if (res.status === 200) return { ok: true, status: 200, delivered: true };
    if (res.status === 202) return { ok: true, status: 202, delivered: !/no_matching_subscribers/.test(text) };
    return { ok: false, reason: `emqx ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Server setting information (cloudprnt-setting.json)
// ---------------------------------------------------------------------------

/** Path segment the printer requests next to its Server URL. */
export const SERVER_SETTING_FILE = "cloudprnt-setting.json";

export type ServerSetting = {
  title: "star_cloudprnt_server_setting";
  version: "1.0.0";
  reloadIntervalMin?: number;
  serverSupportProtocol: string[];
  settingForMQTT?: {
    useTriggerPOST: boolean;
    pollingTimeSec?: number;
    mqttConnectionSetting: {
      hostName: string;
      portNumber: number;
      useTls: boolean;
      keepAliveSec?: number;
      authenticationSetting: { clientId?: string; username: string; password: string };
    };
  };
};

/** URL the printer is expected to GET for its server settings, given its
 *  configured CloudPRNT Server URL (relative resolution, like a browser). */
export function serverSettingUrl(serverUrl: string): string {
  return new URL(SERVER_SETTING_FILE, serverUrl).toString();
}

function intOr(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the Trigger POST settings for one printer, or null when MQTT isn't
 * configured — the caller should then answer 404, which Star defines as
 * "server is HTTP only" and leaves the printer polling over HTTP.
 *
 * `clientId` is the printer id (stable, unique per printer). Star's AWS
 * sample uses the literal "{MAC}" placeholder instead; avoided here because
 * the substituted MAC format isn't documented.
 */
export function serverSetting(env: MqttEnv, printerId: string): ServerSetting | null {
  if (isOff(env.MQTT_ENABLED)) return null;
  const user = env.MQTT_PRINTER_USERNAME;
  const pass = env.MQTT_PRINTER_PASSWORD;
  let host = env.MQTT_BROKER_HOST?.trim();
  if (!host && env.MQTT_API_URL) {
    try {
      host = new URL(env.MQTT_API_URL).hostname;
    } catch {
      host = undefined;
    }
  }
  if (!host || !user || !pass) return null;

  return {
    title: "star_cloudprnt_server_setting",
    version: "1.0.0",
    // How often the printer re-reads this file. Long by default: a power cycle
    // always applies changes immediately.
    reloadIntervalMin: intOr(env.MQTT_SETTINGS_RELOAD_MIN, 1440, 5, 10080),
    serverSupportProtocol: ["HTTP", "MQTT"],
    settingForMQTT: {
      useTriggerPOST: true,
      // Safety-net HTTP poll; triggers do the real work (and the booth re-nudges).
      pollingTimeSec: intOr(env.MQTT_FALLBACK_POLL_SEC, 300, 5, 3600),
      mqttConnectionSetting: {
        hostName: host,
        portNumber: intOr(env.MQTT_BROKER_PORT, 8883, 1, 65535),
        useTls: true,
        keepAliveSec: 60,
        authenticationSetting: { clientId: printerId, username: user, password: pass },
      },
    },
  };
}
