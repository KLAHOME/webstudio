import { AuthorizationError, type StrategyVerifyCallback } from "remix-auth";
import {
  OAuth2Strategy,
  type OAuth2Profile,
  type OAuth2StrategyVerifyParams,
} from "remix-auth-oauth2";

/**
 * Minimal OAuth2 strategy for a standard OIDC provider (Nextcloud's `oidc`
 * app), built on `remix-auth-oauth2`'s `OAuth2Strategy` base.
 *
 * IMPORTANT: `apps/builder` depends on `remix-auth-oauth2@^2.3.0` directly
 * (used by the existing `oauth.ws.*` routes), and that is the version a
 * plain `from "remix-auth-oauth2"` import resolves to here - NOT the
 * `remix-auth-oauth2@1.11.2` that `remix-auth-github@1.7.0` uses internally
 * (pnpm keeps that one privately scoped to remix-auth-github's own
 * dependency tree). v2's `OAuth2StrategyOptions` and `userProfile()`
 * signature are different from v1's (camelCase `clientId`/`tokenEndpoint`
 * as URL-likes instead of `clientID`/`tokenURL` as strings, `userProfile`
 * receives the parsed token body instead of a bare access token string).
 * This class targets v2's actual API - confirmed by reading
 * `node_modules/remix-auth-oauth2/build/index.d.ts` for v2.3.0, not by
 * assuming compatibility with remix-auth-github's v1-shaped usage.
 *
 * This intentionally is NOT a patch to `remix-auth-github` or
 * `remix-auth-oauth2` (no vendored/node_modules edits) - it is a small,
 * self-contained strategy class living in application code. The
 * `NextcloudOidcStrategyOptions` field names below intentionally match the
 * v1-style names already used at the auth.server.ts call site (clientID,
 * callbackURL, authorizationURL, tokenURL) so that call site does not need
 * to change; this class maps them onto v2's real option names internally.
 */

export type NextcloudOidcProfile = OAuth2Profile & {
  provider: "nextcloud";
  id: string;
  displayName: string;
  emails: [{ value: string }];
  photos?: [{ value: string }];
  _json: NextcloudUserInfo;
};

type NextcloudUserInfo = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  picture?: string;
  groups?: string[];
};

export type NextcloudOidcStrategyOptions = {
  clientID: string;
  clientSecret: string;
  callbackURL: string;
  authorizationURL: string;
  tokenURL: string;
  userInfoURL: string;
  /**
   * Nextcloud group name required to be allowed to log in. Checked
   * server-side against the `groups` claim from the userinfo response.
   * A client-side-only check would not restrict access (same rationale as
   * the Dolibarr Nextcloud-OIDC integration, see
   * docker-stacks/dolibarr/OIDC-MCP.md in KLAHOME/IaC).
   */
  requiredGroup: string;
  scope?: string;
};

export const NextcloudOidcStrategyDefaultName = "nextcloud";

export class NextcloudOidcStrategy<User> extends OAuth2Strategy<
  User,
  NextcloudOidcProfile
> {
  name = NextcloudOidcStrategyDefaultName;
  private userInfoURL: string;
  private requiredGroup: string;

  constructor(
    {
      clientID,
      clientSecret,
      callbackURL,
      authorizationURL,
      tokenURL,
      userInfoURL,
      requiredGroup,
      scope,
    }: NextcloudOidcStrategyOptions,
    verify: StrategyVerifyCallback<
      User,
      OAuth2StrategyVerifyParams<NextcloudOidcProfile>
    >
  ) {
    super(
      {
        clientId: clientID,
        clientSecret,
        redirectURI: callbackURL,
        authorizationEndpoint: authorizationURL,
        tokenEndpoint: tokenURL,
        scopes: (scope ?? "openid profile email groups").split(" "),
        // Nextcloud's oidc app supports both client_secret_basic and
        // client_secret_post; prefer basic auth so the client secret never
        // ends up in a logged request body.
        authenticateWith: "http_basic_auth",
      },
      verify
    );
    this.userInfoURL = userInfoURL;
    this.requiredGroup = requiredGroup;
  }

  protected async userProfile(tokens: {
    access_token: string;
  }): Promise<NextcloudOidcProfile> {
    const accessToken = tokens.access_token;

    const response = await fetch(this.userInfoURL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new AuthorizationError(
        `Failed to fetch Nextcloud userinfo: ${response.status}`
      );
    }

    const data = (await response.json()) as NextcloudUserInfo;

    const groups = data.groups ?? [];
    if (!groups.includes(this.requiredGroup)) {
      // Server-side enforcement: this is the actual access boundary, not a
      // hint. Never rely on a client-side claim check for this.
      throw new AuthorizationError(
        `Nextcloud account is not a member of the required group "${this.requiredGroup}"`
      );
    }

    if (!data.email) {
      throw new AuthorizationError(
        "Nextcloud account has no email address on file"
      );
    }

    const displayName = data.preferred_username ?? data.name ?? data.sub;

    const profile: NextcloudOidcProfile = {
      provider: "nextcloud",
      id: data.sub,
      displayName,
      emails: [{ value: data.email }],
      photos: data.picture ? [{ value: data.picture }] : undefined,
      _json: data,
    };

    return profile;
  }
}
