import type { Duration } from "./duration.interface";

export type TlsVersion = "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";

/**
 * TLS options for Bun native TCP/TLS sockets (`Bun.connect` / `socket.upgradeTLS`).
 */
export interface SmtpTlsOptions {
  /** Trusted CA certificate(s) in PEM format (replaces default Mozilla CAs when set). */
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  /** Client certificate chain(s) in PEM format for mutual TLS. */
  cert?: string | Uint8Array | Array<string | Uint8Array>;
  /** Client private key(s) in PEM format for mutual TLS. */
  key?:
    | string
    | Uint8Array
    | Array<
        string | Uint8Array | { pem: string | Uint8Array; passphrase?: string }
      >;
  /** Passphrase for an encrypted client private key. */
  passphrase?: string;
  /** PEM-formatted CRL(s). */
  crl?: string | Uint8Array | Array<string | Uint8Array>;
  /** SNI server name (alias of `serverName`). */
  servername?: string;
  /** SNI server name (`serverName` wins if both are set). */
  serverName?: string;
  /** Verify peer certificate chain and hostname. Default `true`. */
  rejectUnauthorized?: boolean;
  /** Minimum accepted TLS protocol version. Default `"TLSv1.2"`. */
  minVersion?: TlsVersion;
  /** Maximum accepted TLS protocol version. */
  maxVersion?: TlsVersion;
  /** OpenSSL cipher suite list. */
  ciphers?: string;
  /** OpenSSL `SSL_OP_*` bitmask. */
  secureOptions?: number;
  /** ALPN protocols. */
  ALPNProtocols?: string | Uint8Array;
  /** Reduce memory usage (`OPENSSL_RELEASE_BUFFERS`). */
  lowMemoryMode?: boolean;
}

/**
 * Structural representation of a key object (e.g. Node `KeyObject`) without
 * importing `node:crypto`.
 */
export interface DkimKeyObjectLike {
  readonly type: string;
  readonly asymmetricKeyType?: string;
  readonly asymmetricKeyDetails?: {
    readonly modulusLength?: number;
    readonly namedCurve?: string;
  };
  export(options?: never): unknown;
}

export type DkimPrivateKeyInput =
  | string
  | Uint8Array
  | CryptoKey
  | DkimKeyObjectLike;

export type SmtpAuth =
  | {
      user: string;
      pass: string;
    }
  | {
      user: string;
      accessToken: string | (() => string | Promise<string>);
    };

export interface SmtpTransportOptions {
  /**
   * `smtp://user:pass@host:587` or `smtps://user:pass@host:465` (user and password
   * percent-encoded). `smtps://` turns on `secure`; with `smtp://`, port 465 still does,
   * as without a URL. Fields set next to it win.
   */
  url?: string;
  host?: string;
  /** Default 465 with `secure`, else 587. */
  port?: number;
  /** Implicit TLS from the first byte, as on port 465. Default: `true` when the port is 465. */
  secure?: boolean;
  /**
   * Without `secure`: upgrade with STARTTLS. `required` (the default) refuses a server
   * that doesn't offer it; `opportunistic` (the default for localhost) upgrades when
   * offered; `never` stays in plaintext. Credentials are never sent unencrypted except
   * to localhost.
   */
  startTls?: "required" | "opportunistic" | "never";
  /**
   * TLS options for Bun native TLS: `ca` for a private CA, `servername`/`serverName`,
   * `minVersion` (default TLSv1.2). Certificates are verified; turning that off
   * (`rejectUnauthorized: false`) lets anyone on the path read the mail and the password.
   */
  tls?: SmtpTlsOptions;
  /**
   * `{ user, pass }` for AUTH PLAIN or LOGIN (whichever the server offers), or
   * `{ user, accessToken }` for XOAUTH2 (Gmail, Microsoft 365). `accessToken` may be a
   * function, called for every new connection, so it can return a fresh token.
   */
  auth?: SmtpAuth;
  /** Forces a mechanism instead of picking one from the server's list. */
  authMethod?: "PLAIN" | "LOGIN" | "XOAUTH2";
  /** The EHLO name. Default: the host name when fully qualified, else the local address. */
  name?: string;
  /**
   * Reuse connections. `true` means `{ maxConnections: 5, maxMessages: 100, idleTimeout: '30s' }`.
   * Default `false`: one connection per message.
   */
  pool?: boolean | SmtpPoolOptions;
  timeouts?: {
    /** TCP connect and TLS handshake. Default `'30s'`. */
    connect?: Duration;
    /** The server's greeting. Default `'30s'`. */
    greeting?: Duration;
    /** Each command's reply. Default `'1m'`. */
    command?: Duration;
    /**
     * Transmitting the message, and then the reply to it, when servers run their
     * filters: each may take this long. Default `'5m'`.
     */
    data?: Duration;
  };
  /** Sign every message with DKIM. */
  dkim?: DkimOptions;
}

export interface SmtpPoolOptions {
  /** Default 5. Sends beyond it wait for a free connection. */
  maxConnections?: number;
  /** Messages per connection before it is replaced. Default 100. */
  maxMessages?: number;
  /** An idle connection is closed after this long. Default `'30s'`. */
  idleTimeout?: Duration;
}

/** DKIM signing (RFC 6376), relaxed/relaxed, with `rsa-sha256` or `ed25519-sha256` (RFC 8463). */
export interface DkimOptions {
  /** The signing domain (`d=`), usually the `From` address's domain: `example.com`. */
  domainName: string;
  /** The selector (`s=`): the public key is published at `<selector>._domainkey.<domainName>`. */
  keySelector: string;
  /** An RSA (2048 bits or more) or Ed25519 private key (PEM, DER, WebCrypto `CryptoKey`, or key object). */
  privateKey: DkimPrivateKeyInput;
  /**
   * Header fields to sign, when present. Default: From, Reply-To, To, Cc, Subject, Date,
   * Message-ID, MIME-Version, Content-Type, Content-Transfer-Encoding, plus the message's
   * custom headers. `From` is always signed, and listed once more than it occurs
   * (over-signing), so nobody can add a second From below the signature.
   */
  headers?: string[];
}
