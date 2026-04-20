# Configuring Star CloudPRNT Printers — Landscape & Options

Survey of how other projects provision Star CloudPRNT printers and what's
realistic for us. Compiled 2026-04-20.

## What Star officially supports

**Config is web-UI only.** Star's official docs do not document any remote
config API, MQTT config topic, or file-push mechanism for the printer itself.
The TSP100IV online manual and CloudPRNT Developer Guide describe configuration
exclusively through the printer's embedded web server (login `root` / `public`
on HI01x, varies by model).

- Configurable fields: Service URL, Poll Interval, username/password (HTTP
  Basic), custom CA certs, TLS cipher suite, TLS 1.3 toggle.
- Changes require Save + reboot of the printer.
- MQTT mode (firmware 2.2+) uses the same web UI — the Service URL scheme
  (`http://` vs `mqtt://`) determines the protocol. No separate MQTT config
  path.
- Star Micronics Cloud Services (starmicronicscloud.com) is Star's hosted
  product that offers "remote provisioning" — but that's a closed commercial
  offering routing through their backend, not a public API you can call.

## What other projects do on GitHub

Every open-source CloudPRNT project is **server-side only**. None ship a tool
for remotely configuring the printer, because the protocol doesn't expose one.

- **star-micronics/cloudprnt-sdk** (26★, official) — server SDK only: decode
  polls, serialize jobs, convert markup. No client-provisioning code.
- **star-micronics/star-cloudprnt-for-woocommerce** (10★) — WordPress plugin.
  Setup docs: "go to printer web UI, enter URL".
- **star-micronics/starlabs-cloudprnt-sample-server-php-aws** (4★) — MQTT
  sample using AWS IoT as broker. Printer still manually pointed at MQTT URL.
- **receiptline/receiptline** (737★) — thermal-printer markup library with a
  CloudPRNT example. Prints, doesn't configure.
- **openthc/cloudprnt-server**, **bvisible/CloudPRNT** — third-party server
  implementations. Same pattern: manual printer-side setup.
- **star-micronics/StarPRNT-SDK-iOS/Android** — mobile SDKs for *printing*
  over BLE/USB/LAN, not config. (Star's own "Quick Setup Utility" app does
  config, but it's closed-source.)

**Takeaway:** if zero-touch remote config existed, someone would have built
it by now. Nobody has.

## Realistic options for us

### A. Manual paste-in (simplest, works today)

`receiptd printer pair` emits a URL + Basic credentials as a copy-pasteable
block. User logs into their printer's web UI (one URL, one form), pastes four
fields, reboots.

- **Pros:** zero automation, zero fragility, reliable across firmware versions,
  ~90 seconds of user time per printer.
- **Cons:** not "zero-touch".
- **Verdict:** ship this first. It's the baseline everyone else does.

### B. Local Playwright script (zero-touch, LAN-side)

A small script the user runs on their laptop. Does mDNS/SSDP discovery to
find the printer on the LAN, opens `http://<printer-ip>/` in headless Chrome,
logs in, fills the CloudPRNT form, clicks Save + Reboot. Could ship as
`receiptd printer pair --auto` invoking a bundled Playwright script.

- **Pros:** actually zero-touch for the user. Cross-platform via `npx`.
- **Cons:** requires Node + Playwright on user's machine (~300MB install).
  Selectors break if Star updates the web UI firmware. Still requires the
  user's machine to be on the same LAN as the printer — can't be driven from
  the cloud.
- **Verdict:** worth a prototype after (A) ships, gated behind a feature flag
  so failures fall back to manual.

### C. Reverse-engineer Star's "Quick Setup Utility" app

Star ships a mobile app that configures printers over BLE + LAN. We could
decompile the Android APK, sniff BLE with HCI snoop logs or mitmproxy the LAN
traffic, and replicate whatever config protocol it uses.

- **Pros:** if it works, we inherit Star's own config mechanism — probably
  more stable than the web UI.
- **Cons:** significant effort (2–5 days), fragile across firmware updates,
  likely violates Star's ToS, no maintenance upside unless we hit multi-tenant
  scale. Community projects have reverse-engineered cheaper BLE printers
  (e.g. the "cat printer", Fichero label printer) but Star TSP100IV is on a
  different tier — bigger reversing surface.
- **Verdict:** skip until proven necessary.

### D. CUPS / IPP remote admin

TSP100IV supports IPP Everywhere. IPP has a documented `Set-Printer-Attributes`
operation that *can* set some printer attributes remotely.

- **Pros:** standard, documented.
- **Cons:** from spot-checking the Star IPP attribute support, CloudPRNT-specific
  fields (poll URL, Basic creds) are not in the IPP attribute set — those are
  Star's extension, exposed only via the web UI. IPP changes things like tray
  selection, not cloud endpoints.
- **Verdict:** dead end for our use case, but easy to verify if someone wants
  to try.

## What this means for the cloud deploy

Whether Fly or Cloudflare, **the printer lives behind the user's NAT and can
only be configured from inside that network.** There's no "cloud-driven
provisioning" path that avoids a local step. The cloud can hand out the URL
and credentials; a local step (manual paste or Playwright) applies them to
the printer.

This is true for every similar product (Square Reader, HP Smart setup, etc.) —
they all rely on a local app or a local QR-code + manual step. We're not
missing some industry trick.

### Recommended progression

1. **Now:** implement `receiptd printer pair` that returns a pasteable config
   block. Roadmap step 8 (per-printer secrets) enables this.
2. **When inviting other users:** ship `receiptd printer pair --auto` with a
   bundled Playwright script. Falls back to manual paste on failure.
3. **Only if scaling to hundreds of tenants:** invest in reverse-engineering
   Star's Quick Setup app. Probably still not worth it at that scale — the
   `--auto` Playwright path is good enough.

## MQTT-mode aside

Orthogonal to the config question, but worth noting: MQTT mode (firmware 2.2+)
changes the runtime protocol, not the config mechanism. Printer subscribes to
topics instead of polling. For our scale-to-zero concern on Fly — a CF Worker
or Mosquitto broker in front would mean the printer holds a long-lived MQTT
connection to the broker, and the broker only contacts Fly when there's actual
work. Still needs a broker that stays up, so it's really "scale-the-broker-to-
zero" rather than "scale-everything-to-zero".
