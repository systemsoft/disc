/**
 * Bridge between the server's AuthContext and the access module's AccessContext.
 */

import type { AccessContext } from "../access/types.ts";
import type { AuthContext } from "./types.ts";

export function authContextToAccessContext(
  auth: AuthContext,
  sessionGlobals?: Map<string, unknown>
): AccessContext {
  return {
    globals: sessionGlobals,
    userId: auth.userId,
    userRole: auth.roles.length > 0 ? auth.roles[0] : undefined,
    sessionData: auth.jwtClaims as Record<string, unknown> | undefined,
    requestContext: {
      roles: auth.roles,
      permissions: auth.permissions
    }
  };
}
