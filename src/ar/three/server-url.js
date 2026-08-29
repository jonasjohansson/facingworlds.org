import { GAME_CONFIG } from "../../game/config/game-config.js";

// Which game server the spectator table watches.
//
// The URL is not duplicated here - it comes from GAME_CONFIG, the same place the game
// itself reads it - but the AR page has one problem the game does not: it is used from
// a phone. A phone opening https://192.168.1.42:8080/ar/ cannot reach "localhost", so
// falling back to GAME_CONFIG.NETWORK.LOCAL_URL there would silently watch nothing.
//
// Resolution order:
//   1. ?server=ws://host:port      explicit, wins over everything (testing)
//   2. localhost / 127.0.0.1       the developer's own machine -> LOCAL_URL
//   3. a bare IPv4 host            a phone on the LAN -> ws(s)://<that host>:8081
//   4. anything else               PRODUCTION_URL
//
// Note on mixed content: a secure page may not open a plain ws:// socket to an
// arbitrary host - browsers block it outright. Loopback is exempt, which covers case 2.
// Case 3 is the phone case and is NOT exempt, so the scheme is taken from the page: an
// https:// page asks for wss://, which needs the game server started with TLS
// (SSL_CERT/SSL_KEY, same cert pair the static server uses - see `npm run server:tls`).
// Over plain http:// on the LAN it stays ws:// and no TLS is needed. Either way a
// blocked or refused socket is handled like an unreachable one: the page keeps tracking.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", ""]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** @returns {string} a ws:// or wss:// URL, without the ?spectate flag */
export function getSpectatorUrl() {
  const params = new URLSearchParams(window.location.search);

  const override = params.get("server");
  if (override) {
    return override;
  }

  const host = window.location.hostname;

  if (LOOPBACK.has(host)) {
    return GAME_CONFIG.NETWORK.LOCAL_URL;
  }

  if (IPV4.test(host)) {
    const port = portOf(GAME_CONFIG.NETWORK.LOCAL_URL) || "8081";
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${host}:${port}`;
  }

  return GAME_CONFIG.NETWORK.PRODUCTION_URL;
}

function portOf(url) {
  try {
    return new URL(url).port;
  } catch {
    return "";
  }
}
