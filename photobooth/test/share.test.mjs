import test from "node:test";
import assert from "node:assert/strict";
import { JOIN_URL, appJoinLink, fragValue, webBoothLink } from "../public/share.js";

test("web booth link: origin + #pin=", () => {
  assert.equal(webBoothLink("https://booth.receiptd.sh", "1234"), "https://booth.receiptd.sh/#pin=1234");
  assert.equal(webBoothLink("https://booth.receiptd.sh/party.html?x#y", "1234"), "https://booth.receiptd.sh/#pin=1234");
  assert.equal(webBoothLink("https://booth.receiptd.sh", "a&b=c d#%+"), "https://booth.receiptd.sh/#pin=a%26b%3Dc%20d%23%25%2B");
});

test("index.html boot reads the PIN back out of the hash", () => {
  for (const pin of ["1234", "a&b=c d#%+", "ünï", "Gobble Gobble", "turkey-pie 2026"]) {   // word / phrase PINs too
    const hash = new URL(webBoothLink("https://booth.receiptd.sh", pin)).hash;
    assert.equal(new URLSearchParams(hash.slice(1)).get("pin"), pin);   // what index.html does
  }
});

test("app link: join URL + #server=…&key=…", () => {
  assert.equal(JOIN_URL, "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI");
  assert.equal(appJoinLink("https://booth.receiptd.sh/", "1234"),
    "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI#server=https://booth.receiptd.sh&key=1234");
  const u = new URL(appJoinLink("https://booth.receiptd.sh", "a&b"));
  assert.equal(u.searchParams.get("k"), "_Txpzn6Mg2mI");          // the join Worker's key is untouched
  const f = new URLSearchParams(u.hash.slice(1));
  assert.equal(f.get("server"), "https://booth.receiptd.sh");
  assert.equal(f.get("key"), "a&b");
});

test("fragValue keeps URLs readable, escapes separators", () => {
  assert.equal(fragValue("https://x.y:8443/p?q@"), "https://x.y:8443/p?q@");
  assert.equal(fragValue("&=+#% "), "%26%3D%2B%23%25%20");
});

test("word / phrase PINs: kept exactly (case, inner spaces), URL-encoded", () => {
  assert.equal(webBoothLink("https://booth.receiptd.sh", "Gobble Gobble"), "https://booth.receiptd.sh/#pin=Gobble%20Gobble");
  assert.equal(appJoinLink("https://booth.receiptd.sh", "Gobble Gobble"),
    "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI#server=https://booth.receiptd.sh&key=Gobble%20Gobble");
});
