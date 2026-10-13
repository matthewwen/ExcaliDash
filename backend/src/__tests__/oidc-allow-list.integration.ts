import crypto from "crypto";
import { spawnSync } from "node:child_process";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverMock = vi.fn();
const callbackMock = vi.fn();
const clientConfigs: Record<string, unknown>[] = [];
const issuerMetadata = {
  issuer: "https://issuer.example",
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
  id_token_signing_alg_values_supported: ["HS256", "RS256"],
};
const discoveredIssuer = {
  metadata: issuerMetadata,
} as any;

Object.defineProperty(discoveredIssuer, "issuer", {
  get: () => issuerMetadata.issuer,
  enumerable: true,
});

vi.mock("openid-client", () => {
  class MockClient {
    issuer = discoveredIssuer;

    constructor(config: Record<string, unknown>) {
      clientConfigs.push({ ...config });
    }

    callbackParams(req: { query: unknown }) {
      return req.query;
    }

    callback(...args: unknown[]) {
      return callbackMock(...args);
    }

    authorizationUrl() {
      return "https://issuer.example/auth";
    }
  }

  discoveredIssuer.Client = MockClient;
  discoverMock.mockResolvedValue(discoveredIssuer);

  return {
    Issuer: {
      discover: discoverMock,
    },
    generators: {
      state: () => "state-fixed",
      nonce: () => "nonce-fixed",
      codeVerifier: () => "verifier-fixed",
      codeChallenge: () => "challenge-fixed",
    },
  };
});

const base64UrlEncode = (value: Buffer | string): string => {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const signFlowPayload = (encodedPayload: string, secret: string): string =>
  base64UrlEncode(
    crypto.createHmac("sha256", secret).update(encodedPayload, "utf8").digest(),
  );

const makeFlowCookie = (
  secret: string,
  overrides: Partial<{
    state: string;
    nonce: string;
    codeVerifier: string;
    returnTo: string;
    expiresAt: number;
  }> = {},
) => {
  const payload = {
    state: "state-fixed",
    nonce: "nonce-fixed",
    codeVerifier: "verifier-fixed",
    returnTo: "/",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signFlowPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
};

const createPrismaMock = (options?: {
  providerIdentity?: { id: string; issuer: string; subject: string } | null;
}) => {
  const user = {
    id: "user-1",
    username: null,
    email: "alice@example.com",
    name: "Alice",
    role: "USER",
    mustResetPassword: false,
    isActive: true,
  };

  const providerIdentity = options?.providerIdentity ?? null;

  const tx = {
    authIdentity: {
      findUnique: vi.fn(async (args?: Record<string, unknown>) => {
        const where = (args?.where || {}) as Record<string, unknown>;
        if (where.issuer_subject) {
          return null;
        }
        if (where.provider_userId) {
          return providerIdentity;
        }
        return null;
      }),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
    },
    user: {
      findUnique: vi.fn(async () => user),
      count: vi.fn(async () => 1),
      create: vi.fn(async () => user),
    },
    collection: {
      findFirst: vi.fn(async () => ({ id: "trash:user-1" })),
      create: vi.fn(async () => ({})),
    },
  };

  return {
    $transaction: vi.fn(async (runner: (arg: typeof tx) => Promise<unknown>) =>
      runner(tx),
    ),
    refreshToken: {
      create: vi.fn(async () => ({})),
    },
    __tx: tx,
  };
};

const createApp = async (
  idTokenAlgOverride: string | null,
  issuerUrlOverride: string | null = null,
  prismaOverride?: Record<string, unknown>,
  allowedEmails: string[] = [],
) => {
  const { registerOidcRoutes } = await import("../auth/oidcRoutes");
  const app = express();
  const router = express.Router();
  app.use(router);
  registerOidcRoutes({
    router,
    prisma: (prismaOverride || createPrismaMock()) as any,
    ensureAuthEnabled: vi.fn(async () => true),
    ensureSystemConfig: vi.fn(async () => ({
      id: "default",
      oidcJitProvisioningEnabled: true,
    })),
    sanitizeText: (input: unknown) => String(input ?? ""),
    generateTokens: vi.fn(() => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    })),
    setAuthCookies: vi.fn(),
    getRefreshTokenExpiresAt: () => new Date(Date.now() + 60_000),
    isMissingRefreshTokenTableError: () => false,
    config: {
      authMode: "oidc_enforced",
      jwtSecret: "test-secret",
      enableRefreshTokenRotation: false,
      enableAuditLogging: false,
      oidc: {
        enabled: true,
        enforced: true,
        providerName: "Test OIDC",
        issuerUrl: issuerUrlOverride || "https://issuer.example",
        discoveryUrl: null,
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app.example/api/auth/oidc/callback",
        idTokenSignedResponseAlg: idTokenAlgOverride,
        tokenEndpointAuthMethod: null,
        scopes: "openid email profile",
        emailClaim: "email",
        emailVerifiedClaim: "email_verified",
        allowedEmails,
        groupsClaim: "groups",
        adminGroups: [],
        requireEmailVerified: true,
        jitProvisioning: true,
        firstUserAdmin: true,
      },
    },
  });
  return app;
};

describe("OIDC email allow-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientConfigs.length = 0;
  });

  it("denies an email absent from the allow-list before identity lookup", async () => {
    const prisma = createPrismaMock();
    callbackMock.mockResolvedValue({
      claims: () => ({
        sub: "subject-1",
        email: "blocked@example.com",
        email_verified: true,
      }),
    });

    const app = await createApp(null, null, prisma as any, [
      "alice@example.com",
    ]);
    const response = await request(app)
      .get("/oidc/callback?code=test-code&state=state-fixed")
      .set("Cookie", [`excalidash-oidc-flow=${makeFlowCookie("test-secret")}`]);

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("oidcError=email_not_allowed");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("matches allowed emails without regard to case", async () => {
    callbackMock.mockResolvedValue({
      claims: () => ({
        sub: "subject-1",
        email: "Alice@Example.COM",
        email_verified: true,
      }),
    });

    const app = await createApp(null, null, undefined, ["alice@example.com"]);
    const response = await request(app)
      .get("/oidc/callback?code=test-code&state=state-fixed")
      .set("Cookie", [`excalidash-oidc-flow=${makeFlowCookie("test-secret")}`]);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
  });

  it("allows an otherwise valid email when the list is empty", async () => {
    const prisma = createPrismaMock();
    callbackMock.mockResolvedValue({
      claims: () => ({
        sub: "subject-1",
        email: "alice@example.com",
        email_verified: true,
      }),
    });
    const app = await createApp(null, null, prisma, []);
    const response = await request(app)
      .get("/oidc/callback?code=test-code&state=state-fixed")
      .set("Cookie", [`excalidash-oidc-flow=${makeFlowCookie("test-secret")}`]);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("trims and lowercases configured emails and ignores empty entries", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        "console.log(JSON.stringify(require('./src/config').config.oidc.allowedEmails))",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          AUTH_MODE: "oidc_enforced",
          JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
          OIDC_ISSUER_URL: "https://issuer.example",
          OIDC_CLIENT_ID: "client-id",
          OIDC_REDIRECT_URI: "https://app.example/api/auth/oidc/callback",
          OIDC_ALLOWED_EMAILS: " Admin@Example.COM, , second@example.com ",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      '["admin@example.com","second@example.com"]',
    );
  });
});
