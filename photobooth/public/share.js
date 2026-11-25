// Passing the booth to another phone, peer to peer (settings → Share booth,
// party signs): links that carry the booth PIN. Mirrors ios/BoothCore Share.swift.

/** The iOS app's TestFlight sign-up (microapps apps.yaml `booth.join_url`). Once the app is
 *  installed, the same URL is a universal link that opens it. */
export const JOIN_URL = "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI";

/** Fragment-safe value: readable (`https://…` stays as is), but `& = + # %` and spaces are escaped. */
export function fragValue(s) {
  return encodeURIComponent(s).replace(/%(24|2C|2F|3A|3B|3F|40)/g, (m) => decodeURIComponent(m));
}

/** The web booth, unlocked: `<origin>/#pin=<PIN>` (index.html saves it, then drops it from the URL). */
export function webBoothLink(server, pin) {
  return `${new URL(server).origin}/#pin=${fragValue(pin)}`;
}

/** The app: the join link plus `#server=<origin>&key=<PIN>`. The join Worker never sees the
 *  fragment; the installed app reads it (Pairing in BoothCore). */
export function appJoinLink(server, pin, join = JOIN_URL) {
  return `${join.split("#")[0]}#server=${fragValue(new URL(server).origin)}&key=${fragValue(pin)}`;
}
