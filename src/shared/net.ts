/**
 * LAQ-SEC-006 — loopback Host-header validation (DNS-rebinding defense).
 *
 * A DNS-rebinding page can point an attacker-controlled hostname at
 * 127.0.0.1 and reach our loopback HTTP listeners from a victim's browser,
 * carrying that hostname in the Host header. Every data route is already
 * token-gated with constant-time comparison of a 192-bit secret and rebound
 * origins carry no cookie — so this check is defense-in-depth, not the
 * primary gate.
 *
 * Policy: accept loopback literals (127.0.0.1, [::1], any 127.x.y.z) and
 * `localhost`, with or without a port. An ABSENT Host is accepted: rebinding
 * traffic always carries the rebound hostname, while unix-socket clients,
 * bare HTTP/1.0 tools, and handler-level unit tests may omit it.
 */
const LOOPBACK_HOST_RE =
  /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)(?::\d{1,5})?$/i;

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  return LOOPBACK_HOST_RE.test(host.trim());
}
