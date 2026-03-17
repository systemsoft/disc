/**
 * Bridge between the server's AuthContext and the access module's AccessContext.
 */

import type { AuthContext } from "./types.ts";
import type { AccessContext } from "../access/types.ts";

export function authContextToAccessContext(auth: AuthContext): AccessContext {
  return {
    userId: auth.user_id,
    userRole: auth.roles.length > 0 ? auth.roles[0] : undefined,
    sessionData: auth.jwt_claims as Record<string, unknown> | undefined,
    requestContext: {
      roles: auth.roles,
      permissions: auth.permissions,
    },
  };
}
