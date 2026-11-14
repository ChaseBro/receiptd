// Plain `node --test` (Node ≥23.6 strips the TS types on import).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTriggerPublish,
  deviceTopic,
  normalizeMac,
  publishUrl,
  serverSetting,
  serverSettingUrl,
  triggerPrinterPoll,
} from "../src/mqtt.ts";

const MAC = "00:11:62:5a:a9:8b";
const ENV = {
  MQTT_API_URL: "https://abc123.ala.us-east-1.emqxsl.com:8443/api/v5",
  MQTT_APP_KEY: "app-id",
  MQTT_APP_SECRET: "app-secret",
  MQTT_PRINTER_USERNAME: "printer-prod-3838",
  MQTT_PRINTER_PASSWORD: "pw",
};

test("normalizeMac accepts common spellings, rejects junk", () => {
  assert.equal(normalizeMac("00:11:62:5A:A9:8B"), MAC);
  assert.equal(normalizeMac("00-11-62-5a-a9-8b"), MAC);
  assert.equal(normalizeMac("0011.625a.a98b"), MAC);
  assert.equal(normalizeMac("0011625aa98b"), MAC);
  assert.equal(normalizeMac("00:11:62:5a:a9"), null);
  assert.equal(normalizeMac(""), null);
  assert.equal(normalizeMac(undefined), null);
});

test("deviceTopic follows star/cloudprnt/to-device/<mac>/<method>", () => {
  assert.equal(deviceTopic("00:11:62:5A:A9:8B", "request-post"), `star/cloudprnt/to-device/${MAC}/request-post`);
  assert.throws(() => deviceTopic("nope", "request-post"));
  assert.throws(() => deviceTopic(MAC, "request-post/#"));
});

test("buildTriggerPublish is the Trigger POST message", () => {
  const p = buildTriggerPublish(MAC);
  assert.equal(p.topic, `star/cloudprnt/to-device/${MAC}/request-post`);
  assert.deepEqual(JSON.parse(p.payload), { title: "request-post" });
  assert.equal(p.payload_encoding, "plain");
  assert.equal(p.qos, 1);
  assert.equal(p.retain, false);
});

test("publishUrl tolerates trailing slash and an explicit /publish", () => {
  const want = "https://h:8443/api/v5/publish";
  assert.equal(publishUrl("https://h:8443/api/v5"), want);
  assert.equal(publishUrl("https://h:8443/api/v5/"), want);
  assert.equal(publishUrl("https://h:8443/api/v5/publish"), want);
});

test("triggerPrinterPoll posts Basic-auth JSON to EMQX", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  };
  const r = await triggerPrinterPoll(ENV, "00-11-62-5A-A9-8B", { fetchImpl });
  assert.deepEqual(r, { ok: true, status: 200, delivered: true });
  assert.equal(seen.url, "https://abc123.ala.us-east-1.emqxsl.com:8443/api/v5/publish");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Basic " + btoa("app-id:app-secret"));
  assert.deepEqual(JSON.parse(seen.init.body), buildTriggerPublish(MAC));
});

test("triggerPrinterPoll reports 202 no_matching_subscribers as undelivered", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: "no_matching_subscribers", reason_code: 16 }), { status: 202 });
  assert.deepEqual(await triggerPrinterPoll(ENV, MAC, { fetchImpl }), { ok: true, status: 202, delivered: false });
});

test("triggerPrinterPoll never throws", async () => {
  const boom = async () => {
    throw new TypeError("network down");
  };
  const r1 = await triggerPrinterPoll(ENV, MAC, { fetchImpl: boom });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /network down/);

  const r2 = await triggerPrinterPoll(ENV, MAC, {
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  assert.deepEqual(r2, { ok: false, reason: "emqx 401: nope" });

  // Unconfigured / killed / no MAC: no fetch at all.
  const never = async () => assert.fail("should not fetch");
  assert.equal((await triggerPrinterPoll({}, MAC, { fetchImpl: never })).ok, false);
  assert.equal((await triggerPrinterPoll({ ...ENV, MQTT_ENABLED: "off" }, MAC, { fetchImpl: never })).ok, false);
  assert.equal((await triggerPrinterPoll(ENV, null, { fetchImpl: never })).ok, false);
});

test("triggerPrinterPoll times out instead of hanging", async () => {
  const hang = (_url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const t0 = Date.now();
  const r = await triggerPrinterPoll(ENV, MAC, { fetchImpl: hang, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Timeout/);
  assert.ok(Date.now() - t0 < 1000);
});

test("serverSettingUrl sits beside the printer's Server URL", () => {
  assert.equal(
    serverSettingUrl("https://cprnt.receiptd.sh/cprnt/printer-prod-3838"),
    "https://cprnt.receiptd.sh/cprnt/cloudprnt-setting.json",
  );
});

test("serverSetting builds the Trigger POST settings", () => {
  const s = serverSetting(ENV, "printer-prod-3838");
  assert.deepEqual(s, {
    title: "star_cloudprnt_server_setting",
    version: "1.0.0",
    reloadIntervalMin: 1440,
    serverSupportProtocol: ["HTTP", "MQTT"],
    settingForMQTT: {
      useTriggerPOST: true,
      pollingTimeSec: 300,
      mqttConnectionSetting: {
        hostName: "abc123.ala.us-east-1.emqxsl.com",
        portNumber: 8883,
        useTls: true,
        keepAliveSec: 60,
        authenticationSetting: { clientId: "printer-prod-3838", username: "printer-prod-3838", password: "pw" },
      },
    },
  });
});

test("serverSetting honours overrides and returns null when off/unconfigured", () => {
  const s = serverSetting(
    { ...ENV, MQTT_BROKER_HOST: "broker.example", MQTT_BROKER_PORT: "8884", MQTT_FALLBACK_POLL_SEC: "1" },
    "p",
  );
  assert.equal(s.settingForMQTT.mqttConnectionSetting.hostName, "broker.example");
  assert.equal(s.settingForMQTT.mqttConnectionSetting.portNumber, 8884);
  assert.equal(s.settingForMQTT.pollingTimeSec, 5, "clamped to >=5s");

  assert.equal(serverSetting({ ...ENV, MQTT_ENABLED: "false" }, "p"), null);
  assert.equal(serverSetting({ ...ENV, MQTT_PRINTER_PASSWORD: "" }, "p"), null);
  assert.equal(serverSetting({}, "p"), null);
});
