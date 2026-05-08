/**
 * Minimal PEM/X.509 leaf-certificate inspection.
 *
 * We need exactly one piece of information out of the configured TLS
 * cert: the `notAfter` field, so the Prometheus exporter can publish a
 * cert-expiry gauge (ports geldata/gel#6205). Pulling in a full ASN.1
 * library for that would be wildly disproportionate, so this module
 * walks just enough of the DER `TBSCertificate` to find the `Validity`
 * sequence and decode `notAfter` (UTCTime or GeneralizedTime).
 *
 * Only the leaf (first) certificate in the PEM bundle is inspected —
 * intermediates expire on their own schedule and aren't this server's
 * problem.
 */

const PEM_BEGIN = /-----BEGIN CERTIFICATE-----/;
const PEM_END = /-----END CERTIFICATE-----/;

function decodePemBase64(pem: string): Uint8Array {
  const beginMatch = pem.match(PEM_BEGIN);
  const endMatch = pem.match(PEM_END);
  if (!beginMatch || !endMatch || endMatch.index === undefined) {
    throw new Error("PEM envelope missing BEGIN/END CERTIFICATE markers");
  }
  const beginEnd = beginMatch.index! + beginMatch[0].length;
  const body = pem
    .slice(beginEnd, endMatch.index)
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

interface DerHeader {
  tag: number;
  length: number;
  contentStart: number;
  totalEnd: number;
}

function readDerHeader(buf: Uint8Array, offset: number): DerHeader {
  if (offset >= buf.length) {
    throw new Error("DER read past end of buffer");
  }
  const tag = buf[offset];
  const lengthByte = buf[offset + 1];
  let contentStart = offset + 2;
  let length: number;
  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    const numBytes = lengthByte & 0x7f;
    if (numBytes === 0 || numBytes > 4) {
      throw new Error(`Unsupported DER length encoding (${numBytes} bytes)`);
    }
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[contentStart + i];
    }
    contentStart += numBytes;
  }
  return { tag, length, contentStart, totalEnd: contentStart + length };
}

function parseUtcTime(s: string): Date {
  // YYMMDDHHMMSSZ
  if (!/^\d{12}Z$/.test(s)) {
    throw new Error(`Malformed UTCTime: ${s}`);
  }
  const yy = parseInt(s.slice(0, 2), 10);
  const year = yy < 50 ? 2000 + yy : 1900 + yy;
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  const hh = parseInt(s.slice(6, 8), 10);
  const mi = parseInt(s.slice(8, 10), 10);
  const ss = parseInt(s.slice(10, 12), 10);
  return new Date(Date.UTC(year, mm - 1, dd, hh, mi, ss));
}

function parseGeneralizedTime(s: string): Date {
  // YYYYMMDDHHMMSSZ
  if (!/^\d{14}Z$/.test(s)) {
    throw new Error(`Malformed GeneralizedTime: ${s}`);
  }
  const year = parseInt(s.slice(0, 4), 10);
  const mm = parseInt(s.slice(4, 6), 10);
  const dd = parseInt(s.slice(6, 8), 10);
  const hh = parseInt(s.slice(8, 10), 10);
  const mi = parseInt(s.slice(10, 12), 10);
  const ss = parseInt(s.slice(12, 14), 10);
  return new Date(Date.UTC(year, mm - 1, dd, hh, mi, ss));
}

/**
 * Decode a DER time value (tag 0x17 UTCTime or 0x18 GeneralizedTime).
 */
function decodeDerTime(buf: Uint8Array, h: DerHeader): Date {
  const slice = buf.slice(h.contentStart, h.totalEnd);
  const text = new TextDecoder("ascii").decode(slice);
  if (h.tag === 0x17)
    return parseUtcTime(text);
  if (h.tag === 0x18)
    return parseGeneralizedTime(text);
  throw new Error(`Unexpected DER time tag 0x${h.tag.toString(16)}`);
}

/**
 * Extract the leaf certificate's `notAfter` timestamp from a PEM string.
 *
 * The structure we walk is fixed by RFC 5280:
 * ```
 * Certificate ::= SEQUENCE {
 *   tbsCertificate       TBSCertificate,    -- we step into this
 *   signatureAlgorithm   …,
 *   signatureValue       …
 * }
 * TBSCertificate ::= SEQUENCE {
 *   version              [0] EXPLICIT INTEGER OPTIONAL,
 *   serialNumber         INTEGER,
 *   signature            AlgorithmIdentifier,
 *   issuer               Name,
 *   validity             Validity,          -- target
 *   …
 * }
 * Validity ::= SEQUENCE { notBefore Time, notAfter Time }
 * ```
 */
export function extractNotAfter(pem: string): Date {
  const der = decodePemBase64(pem);

  // Outer Certificate SEQUENCE
  const outer = readDerHeader(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error("Expected outer SEQUENCE in certificate");
  }

  // tbsCertificate SEQUENCE
  const tbs = readDerHeader(der, outer.contentStart);
  if (tbs.tag !== 0x30) {
    throw new Error("Expected TBSCertificate SEQUENCE");
  }

  let cursor = tbs.contentStart;

  // Optional [0] EXPLICIT version
  const first = readDerHeader(der, cursor);
  if (first.tag === 0xa0) {
    cursor = first.totalEnd;
  }

  // serialNumber INTEGER
  const serial = readDerHeader(der, cursor);
  if (serial.tag !== 0x02) {
    throw new Error("Expected serialNumber INTEGER");
  }
  cursor = serial.totalEnd;

  // signature AlgorithmIdentifier SEQUENCE
  const sigAlg = readDerHeader(der, cursor);
  if (sigAlg.tag !== 0x30) {
    throw new Error("Expected signature AlgorithmIdentifier SEQUENCE");
  }
  cursor = sigAlg.totalEnd;

  // issuer Name SEQUENCE
  const issuer = readDerHeader(der, cursor);
  if (issuer.tag !== 0x30) {
    throw new Error("Expected issuer SEQUENCE");
  }
  cursor = issuer.totalEnd;

  // validity SEQUENCE { notBefore, notAfter }
  const validity = readDerHeader(der, cursor);
  if (validity.tag !== 0x30) {
    throw new Error("Expected validity SEQUENCE");
  }

  const notBefore = readDerHeader(der, validity.contentStart);
  const notAfterHeader = readDerHeader(der, notBefore.totalEnd);
  return decodeDerTime(der, notAfterHeader);
}

export interface TlsCertExpiry {
  notAfter: Date;
  notAfterUnix: number;
  secondsUntilExpiry: number;
}

/**
 * Read the on-disk PEM cert and compute expiry stats relative to `now`.
 * Throws if the PEM is malformed or unparseable.
 */
export async function readCertExpiry(
  certFile: string,
  now: Date = new Date()
): Promise<TlsCertExpiry> {
  const pem = await Deno.readTextFile(certFile);
  return computeCertExpiry(pem, now);
}

/**
 * Compute expiry stats from a PEM string. Exposed separately so tests
 * can drive it without touching disk.
 */
export function computeCertExpiry(
  pem: string,
  now: Date = new Date()
): TlsCertExpiry {
  const notAfter = extractNotAfter(pem);
  const notAfterUnix = Math.floor(notAfter.getTime() / 1000);
  const nowUnix = Math.floor(now.getTime() / 1000);
  return {
    notAfter,
    notAfterUnix,
    secondsUntilExpiry: notAfterUnix - nowUnix
  };
}
