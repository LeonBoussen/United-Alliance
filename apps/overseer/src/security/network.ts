// Network guard: decides whether a remote address may talk to the overseer.
// Private by default — only loopback, private (RFC 1918), link-local and IPv6
// unique-local addresses are allowed unless `allowPublic` is on. See DESIGN §10.1.
import { isIP } from "node:net";

export const DEFAULT_ALLOWED_CIDRS = [
  "127.0.0.0/8", // loopback
  "10.0.0.0/8", // private
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "169.254.0.0/16", // link-local
  "::1/128", // loopback
  "fc00::/7", // unique local
  "fe80::/10", // link-local
] as const;

interface ParsedCidr {
  family: 4 | 6;
  base: bigint;
  mask: bigint;
}

const BITS = { 4: 32n, 6: 128n } as const;

function ipv4ToBigInt(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) becomes two hextets.
  let addr = ip;
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (v4) {
    const n = ipv4ToBigInt(v4);
    addr = addr.slice(0, -v4.length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array<string>(fill).fill("0"), ...tailParts];
  return parts.reduce((acc, h) => (acc << 16n) | BigInt(parseInt(h, 16)), 0n);
}

/**
 * Strip IPv6 zone ids and unwrap IPv4-mapped IPv6 (`::ffff:192.168.1.5`) so the
 * address is checked against the right family. Returns undefined if not an IP.
 */
export function normalizeAddress(raw: string | undefined): { family: 4 | 6; ip: string } | undefined {
  if (!raw) return undefined;
  let ip = raw.trim().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) ip = mapped;
  const family = isIP(ip);
  if (family === 4 || family === 6) return { family, ip };
  return undefined;
}

export function parseCidr(cidr: string): ParsedCidr {
  const [addr = "", prefixStr] = cidr.split("/");
  const norm = normalizeAddress(addr);
  if (!norm) throw new Error(`Invalid CIDR address: ${cidr}`);
  const bits = BITS[norm.family];
  const prefix = prefixStr === undefined ? bits : BigInt(Number(prefixStr));
  if (prefixStr !== undefined && !/^\d+$/.test(prefixStr)) throw new Error(`Invalid CIDR prefix: ${cidr}`);
  if (prefix < 0n || prefix > bits) throw new Error(`Invalid CIDR prefix: ${cidr}`);
  const mask = prefix === 0n ? 0n : ((1n << prefix) - 1n) << (bits - prefix);
  const value = norm.family === 4 ? ipv4ToBigInt(norm.ip) : ipv6ToBigInt(norm.ip);
  return { family: norm.family, base: value & mask, mask };
}

function matches(ip: { family: 4 | 6; value: bigint }, cidr: ParsedCidr): boolean {
  return ip.family === cidr.family && (ip.value & cidr.mask) === cidr.base;
}

function toValue(norm: { family: 4 | 6; ip: string }) {
  return { family: norm.family, value: norm.family === 4 ? ipv4ToBigInt(norm.ip) : ipv6ToBigInt(norm.ip) };
}

const DEFAULT_PARSED = DEFAULT_ALLOWED_CIDRS.map(parseCidr);

/** True for loopback, private, link-local and unique-local addresses. */
export function isPrivateAddress(raw: string | undefined): boolean {
  const norm = normalizeAddress(raw);
  if (!norm) return false;
  const ip = toValue(norm);
  return DEFAULT_PARSED.some((c) => matches(ip, c));
}

export interface NetworkPolicy {
  allowPublic: boolean;
  extraAllowedCidrs: readonly string[];
}

/**
 * Build a guard for the current policy. Call it with the socket's remote address
 * (`req.socket.remoteAddress`) — not a forwarded header unless trustProxy is on.
 * Unknown or unparsable addresses are rejected when public access is off.
 */
export function createNetworkGuard(policy: NetworkPolicy): (remoteAddress: string | undefined) => boolean {
  if (policy.allowPublic) return () => true;
  const allowed = [...DEFAULT_PARSED, ...policy.extraAllowedCidrs.map(parseCidr)];
  return (remoteAddress) => {
    const norm = normalizeAddress(remoteAddress);
    if (!norm) return false;
    const ip = toValue(norm);
    return allowed.some((c) => matches(ip, c));
  };
}
