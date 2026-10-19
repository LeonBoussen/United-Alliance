import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetworkGuard, isPrivateAddress, normalizeAddress, parseCidr } from "./network.js";

test("private and loopback addresses are private", () => {
  for (const ip of [
    "127.0.0.1",
    "127.10.20.30",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.178.20",
    "169.254.1.1",
    "::1",
    "fd12:3456:789a::1",
    "fe80::1%eth0",
    "::ffff:192.168.1.5",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("public addresses are not private", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "100.64.0.1", // CGNAT/Tailscale: not private unless added explicitly
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("garbage and missing addresses are rejected", () => {
  assert.equal(isPrivateAddress(undefined), false);
  assert.equal(isPrivateAddress(""), false);
  assert.equal(isPrivateAddress("localhost"), false);
  assert.equal(isPrivateAddress("192.168.1"), false);
  assert.equal(normalizeAddress("not-an-ip"), undefined);
});

test("guard: private-only by default", () => {
  const guard = createNetworkGuard({ allowPublic: false, extraAllowedCidrs: [] });
  assert.equal(guard("192.168.1.10"), true);
  assert.equal(guard("::ffff:10.1.2.3"), true);
  assert.equal(guard("203.0.113.7"), false);
  assert.equal(guard(undefined), false);
});

test("guard: extra CIDRs are allowed while private", () => {
  const guard = createNetworkGuard({ allowPublic: false, extraAllowedCidrs: ["100.64.0.0/10", "2001:db8::/32"] });
  assert.equal(guard("100.100.1.1"), true);
  assert.equal(guard("100.128.0.1"), false);
  assert.equal(guard("2001:db8:1::5"), true);
  assert.equal(guard("2001:db9::1"), false);
});

test("guard: allowPublic lets everything through", () => {
  const guard = createNetworkGuard({ allowPublic: true, extraAllowedCidrs: [] });
  assert.equal(guard("203.0.113.7"), true);
});

test("parseCidr validates input", () => {
  assert.throws(() => parseCidr("10.0.0.0/33"));
  assert.throws(() => parseCidr("nope/8"));
  assert.throws(() => parseCidr("10.0.0.0/x"));
  assert.doesNotThrow(() => parseCidr("0.0.0.0/0"));
  assert.doesNotThrow(() => parseCidr("::/0"));
});
