import type { OidcClient } from "../ports/OidcClient";
import keycloak_js from "keycloak-js";
import type { KeycloakConfig } from "keycloak-js";
import { id } from "tsafe/id";
import { Evt } from "evt";
import { getLocalStorage } from "../tools/safeLocalStorage";
import { assert } from "tsafe/assert";
import { createKeycloakAdapter } from "keycloakify";
import { injectGlobalStatesInSearchParams } from "powerhooks";

export async function createKeycloakOidcClient(
    params: {
        keycloakConfig: KeycloakConfig;
    }
): Promise<OidcClient> {

    const { keycloakConfig } = params;

    const keycloakInstance = keycloak_js(keycloakConfig);

    const { evtLocallyStoredOidcAccessToken } = getEvtLocallyStoredOidcAccessToken();

    const { origin } = window.location;

    const isAuthenticated = await keycloakInstance.init({
        "onLoad": "check-sso",
        "silentCheckSsoRedirectUri": `${origin}/silent-sso.html`,
        "responseMode": "query",
        "checkLoginIframe": false,
        "token": evtLocallyStoredOidcAccessToken.state,
        "adapter": createKeycloakAdapter({
            "transformUrlBeforeRedirect": injectGlobalStatesInSearchParams,
            keycloakInstance
        })
    }).catch((error: Error) => error);

    //TODO: Make sure that result is always an object.
    if (isAuthenticated instanceof Error) {
        throw isAuthenticated;
    }

    const login: OidcClient.NotLoggedIn["login"] = async () => {

        await keycloakInstance.login({ "redirectUri": window.location.href });

        return new Promise<never>(() => { });

    };

    if (!isAuthenticated) {

        evtLocallyStoredOidcAccessToken.state = undefined;

        return id<OidcClient.NotLoggedIn>({
            "isUserLoggedIn": false,
            login
        })

    }

    evtLocallyStoredOidcAccessToken.state = keycloakInstance.token!;

    return id<OidcClient.LoggedIn>({
        "isUserLoggedIn": true,
        "evtOidcTokens": evtLocallyStoredOidcAccessToken.pipe(
            oidcAccessToken => oidcAccessToken === undefined ?
                [undefined] :
                [{
                    "accessToken": oidcAccessToken,
                    "idToken": keycloakInstance.idToken!,
                    "refreshToken": keycloakInstance.refreshToken!
                }]
        ),
        "renewOidcTokensIfExpiresSoonOrRedirectToLoginIfAlreadyExpired":
            async params => {

                const { minValidity = 10 } = params ?? {};

                if (evtLocallyStoredOidcAccessToken.state === undefined) {
                    return;
                }

                if (!keycloakInstance.isTokenExpired(minValidity)) {
                    return;
                }

                evtLocallyStoredOidcAccessToken.state = undefined;

                const error = await keycloakInstance.updateToken(-1)
                    .then(
                        () => undefined,
                        (error: Error) => error
                    );

                if (error) {

                    //NOTE: Never resolves
                    await login();

                }

                assert(keycloakInstance.token !== undefined);

                evtLocallyStoredOidcAccessToken.state = keycloakInstance.token;


            },
        "logout": async ({ redirectToOrigin }) => {

            await keycloakInstance.logout({ 
                "redirectUri": redirectToOrigin ? 
                    origin : window.location.href
            });

            return new Promise<never>(() => { });

        },
        "getOidcTokensRemandingValidity": () =>
            (function callee(
                low: number,
                up: number
            ): number {

                const middle = Math.floor(low + (up - low) / 2);

                if (up - low <= 3) {
                    return middle;
                }

                return callee(
                    ...keycloakInstance.isTokenExpired(middle) ?
                        [low, middle] as const :
                        [middle, up] as const
                );

            })(0, 360 * 12 * 30 * 24 * 60 * 60 /*One year*/)
    });

}


const getEvtLocallyStoredOidcAccessToken = () => {

    const { localStorage } = getLocalStorage();

    const key = "onyxia/localStorage/user/token";

    const evtLocallyStoredOidcAccessToken = Evt.create(localStorage.getItem(key) ?? undefined);

    evtLocallyStoredOidcAccessToken
        .toStateless()
        .attach(oidcAccessToken => {

            if (oidcAccessToken === undefined) {

                localStorage.removeItem(key)

            } else {

                localStorage.setItem(key, oidcAccessToken);

            }

        });

    return { evtLocallyStoredOidcAccessToken };


};
