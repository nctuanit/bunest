import { Policy, type PolicyBefore } from "@bunest/security/authz";
import { IdentityStore, type AppUser } from "./users.store";

@Policy()
export class DocumentPolicy implements PolicyBefore<AppUser> {
  constructor(private readonly store: IdentityStore) {}

  before(user: AppUser | null): boolean | undefined {
    if (user?.role === "admin") {
      return true;
    }
    return undefined;
  }

  read(user: AppUser | null, docId: string): boolean {
    if (!user) return false;
    const doc = this.store.findDocument(docId);
    if (!doc) return false;
    return doc.ownerId === user.id;
  }

  update(user: AppUser | null, docId: string): boolean {
    if (!user) return false;
    const doc = this.store.findDocument(docId);
    if (!doc) return false;
    return doc.ownerId === user.id;
  }
}
