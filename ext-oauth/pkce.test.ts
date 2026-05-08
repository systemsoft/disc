/**
 * Tests for PKCE param normalisation (RFC 7636 + Disc-specific carryover).
 *  - gh/geldata#7596: trailing `=` padding is stripped.
 *  - gh/geldata#7026: RFC names (`code_challenge`, `code_challenge_method`,
 *    `code_verifier`) are accepted; legacy aliases route through the same
 *    pickPkceParam shim.
 */

import { assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { describe, it } from "@std/testing/bdd";

import { normalizePkceParam, pickPkceParam } from "./pkce.ts";

describe("normalizePkceParam (gh/geldata#7596)", () => {
  it("strips a single trailing =", () => {
    assertEquals(normalizePkceParam("abcDEF="), "abcDEF");
  });

  it("strips multiple trailing =", () => {
    assertEquals(normalizePkceParam("abcDEF=="), "abcDEF");
  });

  it("leaves unpadded values alone", () => {
    assertEquals(normalizePkceParam("abcDEF"), "abcDEF");
  });

  it("leaves the empty string alone", () => {
    assertEquals(normalizePkceParam(""), "");
  });

  it("does not strip internal =", () => {
    // Internal `=` shouldn't appear in well-formed base64url, but the
    // helper is intentionally narrow — it only touches the trailing
    // run so malformed input still trips downstream validation.
    assertEquals(normalizePkceParam("ab=cd"), "ab=cd");
  });

  it("normalises a real S256 challenge equally whether padded or not", async () => {
    // Recreate the state-manager's S256 derivation so we have a
    // realistic verifier/challenge pair to test against.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    const unpadded = encodeBase64Url(new Uint8Array(digest));
    // Manually pad with one and two `=` and confirm equivalence.
    assertEquals(normalizePkceParam(unpadded), unpadded);
    assertEquals(normalizePkceParam(`${unpadded}=`), unpadded);
    assertEquals(normalizePkceParam(`${unpadded}==`), unpadded);
  });
});

describe("pickPkceParam (gh/geldata#7026)", () => {
  it("returns the RFC name when present, normalised", () => {
    const params = new URLSearchParams("code_verifier=abc%3D");
    assertEquals(pickPkceParam(params, "code_verifier"), "abc");
  });

  it("falls back to legacy alias when RFC name is absent", () => {
    const params = new URLSearchParams("verifier=xyz%3D%3D");
    assertEquals(
      pickPkceParam(params, "code_verifier", "verifier"),
      "xyz"
    );
  });

  it("prefers the RFC name when both are present", () => {
    const params = new URLSearchParams(
      "code_verifier=rfc&verifier=legacy"
    );
    assertEquals(
      pickPkceParam(params, "code_verifier", "verifier"),
      "rfc"
    );
  });

  it("returns null when neither name is present", () => {
    const params = new URLSearchParams("other=1");
    assertEquals(pickPkceParam(params, "code_verifier", "verifier"), null);
  });

  it("works with plain Record sources too", () => {
    assertEquals(
      pickPkceParam(
        { code_challenge: "ch==", code_challenge_method: "S256" },
        "code_challenge"
      ),
      "ch"
    );
  });
});
