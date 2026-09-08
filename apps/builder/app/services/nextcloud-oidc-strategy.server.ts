import { AuthorizationError, type StrategyVerifyCallback } from "remix-auth";
import {
  OAuth2Strategy,
  type OAuth2Profile,
  type OAuth2StrategyVerifyParams,
} from "remix-auth-oauth2";

/**
 * Minimal OAuth2 strategy for a standard OIDC provider (Nextcloud's `oidc`
 * app), built on the same `remix-auth-oauth2` `OAuth2Strategy` base that
 * `remix-auth-github@1.7.0` extends. Unlike `GitHubStrategy`, this does NOT
 * need to override `getAccessToken()`: the base class already parses the
 * token endpoint response as JSON, which is what Nextcloud's OIDC token
 * endpoint returns. Only `userProfile()` needs a Nextcloud-specific mapping,
 * plus a server-side group check that GitHub-style strategies have no
 * equivalent for.
 *
 * This intentionally is NOT a patch to `remix-auth-github` or
 * `remix-auth-oauth2` (no vendored/node_modules edits) — it is a small,
 * self-contained strategy class living in application code.
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
        clientID,
        clientSecret,
        callbackURL,
        authorizationURL,
        tokenURL,
        scope: scope ?? "openid profile email groups",
        // Nextcloud's oidc app supports both client_secret_basic and
        // client_secret_post; prefer basic auth so the client secret never
        // ends up in a logged request body.
        useBasicAuthenticationHeader: true,
      },
      verify
    );
    this.userInfoURL = userInfoURL;
    this.requiredGroup = requiredGroup;
  }

  protected async userProfile(
    accessToken: string
  ): Promise<NextcloudOidcProfile> {
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
