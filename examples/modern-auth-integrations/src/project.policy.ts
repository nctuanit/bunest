import { Policy } from "@bunest/security/authz";
import type { BetterAuthDemoUser } from "./auth.instance";

@Policy()
export class ProjectPolicy {
  read(user: BetterAuthDemoUser | null): boolean {
    return user !== null;
  }

  delete(user: BetterAuthDemoUser | null): boolean {
    return user?.role === "owner";
  }
}
