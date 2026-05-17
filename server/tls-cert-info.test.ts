/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the leaf-cert `notAfter` extractor used by the
 * Prometheus expiry gauge (ports geldata/gel#6205).
 *
 * The certificates baked in here are throwaway self-signed certs
 * generated with `openssl req -x509 -newkey rsa:1024 -nodes` —
 * private keys aren't checked in, only the public-cert PEM. They
 * exist solely to give the parser something deterministic to chew on.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { computeCertExpiry, extractNotAfter } from "./tls-cert-info.ts";

// 1-day cert: notAfter = May 7 06:35:01 2026 UTC (UTCTime encoding).
const CERT_UTCTIME_1DAY = `-----BEGIN CERTIFICATE-----
MIIBnzCCAQgCCQDxaiH8jCFVxjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlk
aXNjLXRlc3QwHhcNMjYwNTA2MDYzNTAxWhcNMjYwNTA3MDYzNTAxWjAUMRIwEAYD
VQQDDAlkaXNjLXRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBALBDOnBF
eVG6TaAbgaVvVQUDoBvF1B8vI2YKXOQsx8iewfxWIDxzgr1DFSdOl1OYOs1nBddX
KkBLh4ddfGl/2oDSDAJi5Fls4Xb5Fiw1/HZsvH9VQybR4PIIKLCx2HQtisVx2XBO
XIDKhI+Qa7P3FCQ2Gv+Krz6AeB0O6NBnL9kBAgMBAAEwDQYJKoZIhvcNAQELBQAD
gYEAhoUSG3ggwqDFCzAh1Sp3wvlOAuVbSyQ5N4Srxp9HQImg0KKRt2EgWdlQ+XHu
do1Fm83ZzcpB4wlf7eLGn1EL9esFAPK4L08SdnJ8t2x+hcXxL/NfSD3pEM/e+G79
ATi9Uo/T87F4zlxQjhIIlvxV+JAuUiyJBR63bsUMEjyv0KY=
-----END CERTIFICATE-----`;

// 30-day cert: notAfter = Jun 5 06:35:05 2026 UTC (UTCTime).
const CERT_UTCTIME_30D = `-----BEGIN CERTIFICATE-----
MIIBpzCCARACCQDN//RRpS6X/DANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDDA1k
aXNjLXRlc3QtMzBkMB4XDTI2MDUwNjA2MzUwNVoXDTI2MDYwNTA2MzUwNVowGDEW
MBQGA1UEAwwNZGlzYy10ZXN0LTMwZDCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkC
gYEAol8fcMjAMnOWY7xvXkpqfhOSaG1i3vpS5GcUHeHTvWNOHVdHrIJD6CkCyAr8
DfZR3SFghDgt+Gm79V8xsDdtkAVBlSqoD6afhHcKk9mOfKn4fx9yz0gb3W6dqRSv
agEEFKhTe+Gwm1pWzGBOxMPFOlhHiIMGAMTNPYEk0T5QnZECAwEAATANBgkqhkiG
9w0BAQsFAAOBgQAO4NysMuECwgNbVXkWeBU/f2NRSr4PPSMixgypxa/ftgX2Od+P
DzTyXMTqEBDvtjrGDBmpWpZGQVANHsLl1bGjE3Rs0zOS5MZlL2QffcNrwHzQD1b9
50dq05cKpjE1I+EX999GHSk7lCKrTGznnlgTgI5lPkjwPL+tiGxsnjn4mQ==
-----END CERTIFICATE-----`;

// Far-future cert: notAfter = Sep 20 06:35:07 2053 UTC (GeneralizedTime,
// since dates >= 2050 force the GeneralizedTime encoding per RFC 5280).
const CERT_GENERALIZED_TIME = `-----BEGIN CERTIFICATE-----
MIIBqTCCARICCQDFQvJZJsynJDANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDDA1k
aXNjLXRlc3QtZmFyMCAXDTI2MDUwNjA2MzUwN1oYDzIwNTMwOTIwMDYzNTA3WjAY
MRYwFAYDVQQDDA1kaXNjLXRlc3QtZmFyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCB
iQKBgQDJ+aC6SxgVHN7E+GbzgFQv/atQmjuoLRmS0hXBNJW2WncnBnwhas9S7bYh
w9+58NeGAfbpYIRVaaV2T19kpq7v2r1YNd1u6kW+WONmeAhY9v+/fKvCSGyqlC8F
p5QEr2gSFkooxW55eHWNW2gk3i2rcmX4ABRyj4wnsM0w+dSR3QIDAQABMA0GCSqG
SIb3DQEBCwUAA4GBAH5yAzY36EEA98Wt4fcXSp1hBeJS0FsGxjp1h+LT9yvPjO/I
H0ylB6xg9Qjo+pwMsE9r9nTgRaZSs/2H2qefGWQ9tca+DhxIU076hrxTeWDecgbF
E18tswqvsKBUm5fMVEOu+iQkdeY0KkuzgzoBqcdCfEH/RQxtlZlvvpJUy7Ts
-----END CERTIFICATE-----`;

Deno.test("extractNotAfter decodes UTCTime (1-day cert)", () => {
  const notAfter = extractNotAfter(CERT_UTCTIME_1DAY);
  assertEquals(notAfter.toISOString(), "2026-05-07T06:35:01.000Z");
});

Deno.test("extractNotAfter decodes UTCTime (30-day cert)", () => {
  const notAfter = extractNotAfter(CERT_UTCTIME_30D);
  assertEquals(notAfter.toISOString(), "2026-06-05T06:35:05.000Z");
});

Deno.test("extractNotAfter decodes GeneralizedTime (post-2050 cert)", () => {
  const notAfter = extractNotAfter(CERT_GENERALIZED_TIME);
  assertEquals(notAfter.toISOString(), "2053-09-20T06:35:07.000Z");
});

Deno.test("extractNotAfter rejects content without PEM markers", () => {
  assertThrows(
    () => extractNotAfter("not a certificate"),
    Error,
    "PEM envelope"
  );
});

Deno.test("computeCertExpiry yields positive secondsUntilExpiry for future cert", () => {
  // Pin "now" to one second after notBefore so we can assert the
  // remaining-seconds count without flake.
  const now = new Date("2026-05-06T06:35:02Z");
  const expiry = computeCertExpiry(CERT_UTCTIME_1DAY, now);
  // 1-day cert: 24h - 1s = 86399 seconds remaining.
  assertEquals(expiry.secondsUntilExpiry, 86399);
  assertEquals(
    expiry.notAfterUnix,
    Math.floor(
      new Date("2026-05-07T06:35:01Z").getTime() / 1000
    )
  );
});

Deno.test("computeCertExpiry returns negative when cert is already expired", () => {
  const now = new Date("2027-01-01T00:00:00Z");
  const expiry = computeCertExpiry(CERT_UTCTIME_1DAY, now);
  assertEquals(expiry.secondsUntilExpiry < 0, true);
});
