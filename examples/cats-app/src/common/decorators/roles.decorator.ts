import { SetMetadata } from "@bunest/core";

export const ROLES_KEY = "roles";

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
