// Relay message guards — pure, side-effect-free so they unit-test without booting the server.

// `hello`/`join`/`leave` are RELAY-authoritative control messages (relay → clients only). Legit clients
// never send them, so a client message carrying one of these types is a forgery — e.g. a peer spoofing
// `{t:"leave"}` would make everyone else drop it from the roster while it keeps playing. The relay drops them.
const RESERVED_TYPES = new Set(["hello", "join", "leave"]);

export function isReservedRelayType(t) {
  return RESERVED_TYPES.has(t);
}
