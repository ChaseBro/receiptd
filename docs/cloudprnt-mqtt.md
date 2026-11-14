# CloudPRNT MQTT "Trigger POST" — instant printing

Goal: the TSP100IV polls the instant a job is queued, not on its next
`pollInterval`. Star's CloudPRNT **Version MQTT, Trigger POST** mode does exactly
that: the server publishes a tiny "poll now" message to a broker the printer
is subscribed to, and the printer immediately does a normal CloudPRNT HTTP POST
poll. Job GET / DELETE stay as they are — no print data goes through MQTT.

Status: researched + publisher/settings code written (`worker/src/mqtt.ts`),
**not yet wired or deployed**. Researched 2026-11-14.

## Sources

| # | Source | What it gave |
|---|--------|--------------|
| S1 | Star CloudPRNT manual, Protocol Guide v2.5.2 (Sep 2025) — `https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/protocol-guide.html` (read via Wayback; star-m.jp was unreachable from here) | Mode selection via "Server setting information request (GET)"; Trigger POST behaviour |
| S2 | Same manual, index — `.../manual/en/index.html` | Supported printers/firmware; TLS; "same CA root set as Mozilla Firefox" (client.html) |
| S3 | MQTT payload spec (JA) — `.../manual/ja/protocol-reference/mqtt-method-reference/mqtt-payload/index.html` (Wayback 2026-04-14) | Topics + payloads for every method, both directions |
| S4 | Star sample server — `github.com/star-micronics/cloudprnt-sdk/ExampleServers/php_queue` (`mqtt_publish.php`, `cloudprnt-setting_Sample/cloudprnt-setting_mqtt_triggerpost.json`, `readme.md`) | Exact publish code + settings JSON |
| S5 | Star AWS IoT sample — `github.com/star-micronics/starlabs-cloudprnt-sample-server-php-aws` (README, `iot_authorizer/index.mjs`) | `clientId`/`username` `{MAC}` placeholders, `tlsSetting.alpn`, per-device topic ACL |
| S6 | Third-party prod implementation — `github.com/bvisible/CloudPRNT` (`cloudprnt/broker.py`, `protocol.py`, `hooks.py`) | Extra settings keys (`pollingTimeSec`, `keepAliveSec`, `reloadIntervalMin`, `deviceSubscribeTopicName`), "settings file sits beside the CloudPRNT URL", 404 = HTTP-only |
| S7 | EMQX Cloud docs — `docs.emqx.com/en/cloud/latest/api/publish_v5.md`, `api/api_deployment.md`, `deployments/port_guide_serverless.md`, `create/restriction.md`, `create/serverless.md` | REST publish API, ports, TLS/SNI, CA, limits |
| S8 | `https://assets.emqx.com/data/emqxsl-ca.crt` | EMQX Serverless CA = **DigiCert Global Root G2** |

Could not fetch (star-m.jp timed out; not in Wayback): the server-info-GET
sub-pages `get-request.html` / `get-response.html` and the MQTT common/topic
pages. Items that only those pages would settle are flagged **(unverified)**.

## How the printer switches to MQTT

1. Firmware: **TSP100IV ≥ 2.2** (TSP100IV SK ≥ 2.2; mC-Print3 MCP31CI/CBI ≥ 5.1)
   [S2]. Check with a self-test print (hold FEED while powering on) or the web UI.
2. The web UI's **Server URL stays the same** (`https://cprnt.receiptd.sh/cprnt/printer-prod-3838`).
   There is no MQTT field in the printer web UI per Star's "Client Settings"
   page [S2]: "A CloudPRNT Version MQTT-compatible printer executes the Server
   setting information request (GET) based on this URL to determine the operating
   protocol." (This corrects the earlier `mqtt://` guess in
   `PRINTER_CONFIG_APPROACHES.md`.) `receiptd printer inspect` can confirm on a
   given firmware — the printer was offline when this was written, so the live
   field list is **not yet captured**.
3. At power-on/network-up (and every `reloadIntervalMin`, [S6]) the printer
   GETs `cloudprnt-setting.json` **beside** its Server URL [S4 layout, S6]:
   `https://cprnt.receiptd.sh/cprnt/cloudprnt-setting.json` (likely with
   `?mac=…` [S6]; it answers an HTTP Basic challenge with its CloudPRNT
   credentials [S6] — both **(unverified)** against Star's own page).
4. **200 + valid JSON** → runs as the JSON says. **Anything else** (404, bad
   JSON, timeout) → CloudPRNT Version HTTP, exactly as today [S3 server-info
   summary, S6]. So the switch is server-controlled and fail-safe.

Settings JSON (Trigger POST) — keys from S4 are confirmed; keys marked † come
from S6 (and S3 refers to `pollingTimeSec` in this response):

```json
{
  "title": "star_cloudprnt_server_setting",
  "version": "1.0.0",
  "reloadIntervalMin": 60,                 // †
  "serverSupportProtocol": ["HTTP", "MQTT"],
  "settingForMQTT": {
    "useTriggerPOST": true,
    "pollingTimeSec": 30,                  // † safety-net POST poll
    "mqttConnectionSetting": {
      "hostName": "<deployment>.emqxsl.com",
      "portNumber": 8883,
      "useTls": true,
      "keepAliveSec": 60,                  // †
      "authenticationSetting": {
        "clientId": "printer-prod-3838",   // S5; optional in S4
        "username": "printer-prod-3838",
        "password": "<broker password>"
      }
    }
  }
}
```

Notes:
- In Trigger POST the printer **stops periodic POST polls by default** [S1:
  "the printer does not execute periodic POST polls (This is the default. You
  can set it to be executed periodically.)"]. `pollingTimeSec` is that knob —
  keep it (30s) so a lost trigger costs ≤30s, not "until the next job".
- `clientId`/`username` accept the literal `"{MAC}"`, substituted by the printer
  [S5]; the substituted format is undocumented, so we use the printer id.
- `tlsSetting: {"alpn": ["mqtt"]}` exists [S5] — only needed for AWS IoT on
  port 443. Not used with EMQX on 8883.
- `deviceSubscribeTopicName` [S6] seems to override the subscribe topic; not used.

## Topics and payloads [S3, S4]

All payloads are JSON. `{mac}` = printer Ethernet MAC, lowercase, colon-separated
(`00:11:62:5a:a9:8b`), as in `printerMAC` of the POST poll [S4, .NET sample
lower-cases it]. Note: Star uses the **Ethernet** MAC even on Wi-Fi [S2].

Server → printer (`star/cloudprnt/to-device/{mac}/<method>`):

| Method | Trigger POST | Payload |
|---|---|---|
| `request-post` | ✓ | `{"title":"request-post"}` — printer does a server poll (POST) now |
| `request-get-server-info` | ✓ | `{"title":"request-get-server-info"}` — re-fetch cloudprnt-setting.json now (handy after changing broker creds) |
| `request-client-status`, `print-job`, `order-client-action`, `claim-barcode-reader`, `output-to-display`, `apply-starconfiguration` | – | Full MQTT / Pass URL only |

Printer → server (`star/cloudprnt/to-server/{mac}/…`: `client-status`,
`print-result`, `starconfiguration-result`, `client-will`): **Full MQTT / Pass
URL only.** S3: "CloudPRNT Version MQTT (Trigger POST)では、プリンターからMQTTメッセージを発行することはありません"
— in Trigger POST the printer publishes nothing; status keeps arriving in the
HTTP POST poll body. (`client-will` is its LWT in Full MQTT mode.)

QoS / retain: Star's samples publish with `mosquitto_pub` defaults (QoS 0, not
retained) [S4]. We publish QoS 1, not retained (retain would just cause a
redundant poll on every reconnect). MQTT 3.1.1 (`-V 311` in S4). Keep-alive:
`keepAliveSec` †; printer default unknown **(unverified)**.

## TLS / CA

- Printer verifies against "the same CA route set as Mozilla Firefox"; custom
  CAs can be installed [S2 client.html].
- EMQX Serverless is TLS-only (8883 MQTTS, 8084 WSS), one-way TLS, CA provided
  by EMQX; their CA file is **DigiCert Global Root G2** [S7, S8] — in Mozilla's
  store, so **no custom CA should be needed**. (Medium-high confidence; confirm
  on first connect.)
- Serverless **requires SNI** ("missing SNI → connection rejected, error -5")
  [S7]. Whether TSP100IV firmware sends SNI on its MQTT socket is
  **(unverified)** — it does for HTTPS; if the printer never shows up in the
  EMQX Clients list, this is the first suspect (fallback: EMQX Dedicated, or a
  different broker).
- Serverless rejects anonymous clients — the printer needs a username/password.

## EMQX Serverless REST publish [S7]

```
POST {api}/publish          # {api} = "API endpoint" on the deployment Overview,
                            #   e.g. https://<id>.<region>.emqxsl.com:8443/api/v5
Authorization: Basic base64(<App ID>:<App Secret>)   # Deployment API Key
Content-Type: application/json
{"topic":"star/cloudprnt/to-device/00:11:62:5a:a9:8b/request-post",
 "payload":"{\"title\":\"request-post\"}","payload_encoding":"plain","qos":1,"retain":false}
```

- `200 {"id": "..."}` → delivered to a subscriber.
- `202 {"message":"no_matching_subscribers","reason_code":16}` → nobody
  subscribed (printer offline / still in HTTP mode). Harmless.
- The `:8443/api/v5` form of `{api}` is from the console/user, not quoted in the
  docs page (which only says `{api}`) — copy it from the console.
- Limits (Serverless): publish ≤10 msg/s per client, 1000 TPS per deployment,
  10 subscriptions/client, MQTT 3.x session expiry 2h [S7 restriction.md].
  Deployments with no activity are stopped after 30 days [S7 serverless.md] —
  the always-connected printer keeps it alive.
- Workers `fetch()` to a non-443 port on a non-Cloudflare host should be fine;
  confirm on first deploy **(unverified)**.

## Code in this repo

`worker/src/mqtt.ts` (no imports; tests: `cd worker && npm test`):

- `triggerPrinterPoll(env, mac, {timeoutMs?})` → publishes `request-post`.
  Never throws, 2.5s timeout, returns `{ok, status, delivered}` or `{ok:false, reason}`.
- `serverSetting(env, printerId)` → the JSON above, or `null` (→ answer 404 =
  "HTTP only") when unconfigured or `MQTT_ENABLED=off`.
- helpers: `normalizeMac`, `deviceTopic`, `buildTriggerPublish`, `publishUrl`,
  `serverSettingUrl`, `SERVER_SETTING_FILE`.

Env (all optional; missing ⇒ HTTP-only, triggers no-op):

| Name | Kind | Value |
|---|---|---|
| `MQTT_API_URL` | var or secret | console "API endpoint", e.g. `https://<id>.<region>.emqxsl.com:8443/api/v5` |
| `MQTT_APP_KEY` | secret | Deployment API Key App ID |
| `MQTT_APP_SECRET` | secret | Deployment API Key App Secret |
| `MQTT_PRINTER_USERNAME` | var | broker username for the printer, e.g. `printer-prod-3838` |
| `MQTT_PRINTER_PASSWORD` | secret | broker password for the printer |
| `MQTT_BROKER_HOST` | var | only if the MQTT host differs from `MQTT_API_URL`'s host |
| `MQTT_BROKER_PORT` | var | default `8883` |
| `MQTT_FALLBACK_POLL_SEC` | var | default `30` (clamped 5–3600) |
| `MQTT_ENABLED` | var | `off` = kill switch |

`receiptd printer inspect --ip 192.168.1.38 --admin-pass …` dumps the web UI
form fields (GET-only, passwords redacted) to confirm no MQTT fields / firmware
differences.

## Integration (pending — `worker/src/index.ts` and `photobooth/src/index.ts` are mid-refactor to a Durable Object)

1. **Worker env type**: `export type Env = MqttEnv & { … }` (import `type MqttEnv`).
2. **Settings route** — must be registered **before** `app.get("/cprnt/:printerId")`,
   otherwise `cloudprnt-setting.json` is treated as a printer id (→ 404, which
   is at least the safe answer):
   ```ts
   app.get(`/cprnt/${SERVER_SETTING_FILE}`, async (c) => {
     const creds = parseBasicAuth(c.req.header("Authorization"));
     if (!creds) return new Response("auth required", { status: 401,
       headers: { "WWW-Authenticate": 'Basic realm="receiptd-cprnt"' } });
     const unauth = await requirePrinterAuth(c.req.raw, c.env, creds.user);
     if (unauth) return unauth;
     const s = serverSetting(c.env, creds.user);
     return s ? c.json(s) : c.text("CloudPRNT HTTP only", 404);
   });
   ```
   Log the first hit (`console.log` with `c.req.url`) to confirm the path/query
   the firmware actually uses. The JSON contains the broker password — never
   serve it unauthenticated.
3. **Trigger after enqueue** (fire-and-forget, after the job is durably queued):
   - cprnt Worker `POST /admin/jobs` (Fly → Worker path), after `enqueue(...)`:
     `c.executionCtx.waitUntil(triggerPrinterPoll(c.env, mac))`
   - booth Worker, after `enqueueMany(...)` succeeds: same with the booth's env.
   - MAC source: the printer's last POST poll already records `mac` in its
     status record (`worker/src/status.ts`, `printerMAC` → `mac`); read it from
     there (or the DO) — or set a `PRINTER_MAC = "00:11:62:5a:a9:8b"` var in the
     booth's `wrangler.toml` to skip the lookup. No MAC ⇒ no-op.
   - Optional: in the DO, trigger once per enqueue batch, not per copy.
4. The POST poll response's `pollInterval: 5` is ignored in MQTT mode (the
   printer uses `pollingTimeSec`); leave it for HTTP fallback.

## EMQX Serverless setup (user)

1. EMQX Cloud console → **New Deployment → Serverless**, region near the
   printer/CF (e.g. us-west-2/us-east-1). Spend limit 0 = free tier only.
2. Deployment **Overview**: note **Address** (MQTT host), port **8883**, and
   **API endpoint** (`https://…:8443/api/v5`).
3. **Access Control → Authentication → +Add**: username `printer-prod-3838`,
   strong random password (≤63 chars to be safe). No user is needed for the
   Worker — it publishes via the REST API.
4. **Access Control → Authorization** (deny-by-default is the safe posture;
   Serverless supports per-username rules):
   - `printer-prod-3838`: **allow subscribe** `star/cloudprnt/to-device/00:11:62:5a:a9:8b/#`;
     **allow publish** `star/cloudprnt/to-server/00:11:62:5a:a9:8b/#` (unused in
     Trigger POST, harmless; covers Full-MQTT LWT later).
   - **deny all** other topics for that user (`#`, pub+sub).
5. **Overview → Deployment API Key → +New API Key** → App ID + App Secret
   (shown once).
6. Sanity check from a laptop with MQTTX: connect TLS to `<host>:8883` as the
   printer user, subscribe `star/cloudprnt/to-device/00:11:62:5a:a9:8b/#`, then
   ```sh
   # EMQX_APP_ID / EMQX_APP_SECRET exported in your shell
   curl --user "$EMQX_APP_ID:$EMQX_APP_SECRET" -H 'Content-Type: application/json' \
     -d '{"topic":"star/cloudprnt/to-device/00:11:62:5a:a9:8b/request-post","payload":"{\"title\":\"request-post\"}","qos":1}' \
     https://<host>:8443/api/v5/publish
   ```
   → expect `200` and the message in MQTTX. Disconnect MQTTX afterwards
   (EMQX takes over a duplicate clientId).
7. Secrets on the cprnt Worker: `wrangler secret put MQTT_APP_KEY`,
   `MQTT_APP_SECRET`, `MQTT_PRINTER_PASSWORD`; vars `MQTT_API_URL`,
   `MQTT_PRINTER_USERNAME`. Booth Worker: `MQTT_API_URL`, `MQTT_APP_KEY`,
   `MQTT_APP_SECRET` (+ `PRINTER_MAC` if used).

## Applying it to the printer (user)

No printer web UI change is needed if the firmware is ≥2.2:

1. Confirm firmware ≥ 2.2 (self-test print). If older, update via Star Quick
   Setup Utility (Use App → firmware update).
2. Deploy the worker with the settings route + secrets.
3. Power-cycle the printer (or wait ≤ `reloadIntervalMin`). It GETs
   `/cprnt/cloudprnt-setting.json`, connects to EMQX — it should appear under
   the deployment's **Clients** as `printer-prod-3838`.
4. Queue a job; it should print within ~1s. `202 no_matching_subscribers` from
   the publish means the printer isn't on the broker (see TLS/SNI note).
5. Rollback: `MQTT_ENABLED=off` (or delete `MQTT_PRINTER_PASSWORD`) and
   power-cycle → printer gets 404 → back to HTTP polling.
