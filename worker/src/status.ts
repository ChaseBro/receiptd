// Printer status capture. Each POST poll updates KV:printer:<id>:status
// with a change-detection + heartbeat gate so write volume stays bounded.
//
// Budget: ~17,280 polls/day/printer at 5s cadence.
//   - Reads: 1/poll (to check prior snapshot).
//   - Writes: only when material fields change OR lastSeenAt > 60s old.
//     Steady-state → ~1,440 writes/day/printer (liveness heartbeats) plus
//     real events. Well inside CF paid tier.

const HEARTBEAT_MS = 60_000;
const STATUS_TTL_SEC = 14 * 24 * 3600;

export const statusKey = (printerId: string) => `printer:${printerId}:status`;

// Fields that come off the printer. Unknown values pass through untouched
// (not overwritten) so polls with partial client_action arrays don't wipe
// previously learned fields.
type MaterialStatus = {
  statusCode?: string;
  mac?: string;
  clientType?: string;
  clientVersion?: string;
  printWidth?: number;
  horizontalRes?: number;
  printingInProgress?: boolean;
};

export type PrinterStatus = MaterialStatus & {
  lastSeenAt: number; // unix ms, updated every write
  lastChangeAt: number; // unix ms, only bumps on material change
};

type PollBody = {
  printerMAC?: string;
  statusCode?: string;
  printingInProgress?: boolean;
  clientAction?: Array<{ request?: string; result?: unknown }>;
};

export function extractFromPoll(poll: unknown): MaterialStatus {
  const out: MaterialStatus = {};
  if (!poll || typeof poll !== "object") return out;
  const p = poll as PollBody;

  if (typeof p.statusCode === "string") out.statusCode = p.statusCode;
  if (typeof p.printerMAC === "string") out.mac = p.printerMAC;
  if (typeof p.printingInProgress === "boolean") out.printingInProgress = p.printingInProgress;

  if (Array.isArray(p.clientAction)) {
    for (const ca of p.clientAction) {
      if (!ca || typeof ca !== "object") continue;
      switch (ca.request) {
        case "ClientType":
          if (typeof ca.result === "string") out.clientType = ca.result;
          break;
        case "ClientVersion":
          if (typeof ca.result === "string") out.clientVersion = ca.result;
          break;
        case "PageInfo":
          if (ca.result && typeof ca.result === "object") {
            const r = ca.result as { printWidth?: number; horizontalResolution?: number };
            if (typeof r.printWidth === "number") out.printWidth = r.printWidth;
            if (typeof r.horizontalResolution === "number") out.horizontalRes = r.horizontalResolution;
          }
          break;
      }
    }
  }
  return out;
}

function materialEqual(a: MaterialStatus, b: MaterialStatus): boolean {
  const keys: (keyof MaterialStatus)[] = [
    "statusCode",
    "mac",
    "clientType",
    "clientVersion",
    "printWidth",
    "horizontalRes",
    "printingInProgress",
  ];
  return keys.every((k) => a[k] === b[k]);
}

/**
 * Update KV:printer:<id>:status based on an incoming poll. Returns nothing;
 * callers should invoke via executionCtx.waitUntil so the write doesn't
 * block the printer response.
 */
export async function updatePrinterStatus(
  kv: KVNamespace,
  printerId: string,
  poll: unknown,
): Promise<void> {
  const now = Date.now();
  const incoming = extractFromPoll(poll);

  const raw = await kv.get(statusKey(printerId));
  const prev = raw ? (JSON.parse(raw) as PrinterStatus) : null;
  const prevMaterial: MaterialStatus = prev
    ? {
        statusCode: prev.statusCode,
        mac: prev.mac,
        clientType: prev.clientType,
        clientVersion: prev.clientVersion,
        printWidth: prev.printWidth,
        horizontalRes: prev.horizontalRes,
        printingInProgress: prev.printingInProgress,
      }
    : {};

  // Merge (don't overwrite known fields with undefined from a partial poll).
  const nextMaterial: MaterialStatus = { ...prevMaterial };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined) (nextMaterial as Record<string, unknown>)[k] = v;
  }

  const changed = !prev || !materialEqual(prevMaterial, nextMaterial);
  const heartbeatDue = !prev || now - prev.lastSeenAt > HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;

  const next: PrinterStatus = {
    ...nextMaterial,
    lastSeenAt: now,
    lastChangeAt: changed ? now : (prev?.lastChangeAt ?? now),
  };
  await kv.put(statusKey(printerId), JSON.stringify(next), {
    expirationTtl: STATUS_TTL_SEC,
  });
}
