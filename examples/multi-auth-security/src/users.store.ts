import { Injectable, type OnModuleInit } from "@bunest/core";
import { PasswordHasher } from "@bunest/security/auth";

export interface AppUser {
  id: string;
  email: string;
  role: "admin" | "member";
  passwordHash: string;
}

export interface SecretDocument {
  id: string;
  ownerId: string;
  title: string;
  content: string;
}

export interface StoredApiKey {
  id: string;
  hash: string;
  userId: string;
}

@Injectable()
export class IdentityStore implements OnModuleInit {
  private readonly users = new Map<string, AppUser>();
  private readonly documents = new Map<string, SecretDocument>();
  private readonly apiKeys = new Map<string, StoredApiKey>();

  constructor(private readonly hasher: PasswordHasher) {}

  async onModuleInit(): Promise<void> {
    if (this.users.size > 0) return;

    const aliceHash = await this.hasher.hash("alice-secret-pass");
    const bobHash = await this.hasher.hash("bob-secret-pass");
    const adminHash = await this.hasher.hash("admin-secret-pass");

    this.users.set("u-alice", {
      id: "u-alice",
      email: "alice@bunest.dev",
      role: "member",
      passwordHash: aliceHash,
    });
    this.users.set("u-bob", {
      id: "u-bob",
      email: "bob@bunest.dev",
      role: "member",
      passwordHash: bobHash,
    });
    this.users.set("u-admin", {
      id: "u-admin",
      email: "admin@bunest.dev",
      role: "admin",
      passwordHash: adminHash,
    });

    this.documents.set("doc-1", {
      id: "doc-1",
      ownerId: "u-alice",
      title: "Alice Architecture Spec",
      content: "Zero-dependency Bunest security design.",
    });
    this.documents.set("doc-2", {
      id: "doc-2",
      ownerId: "u-bob",
      title: "Bob Operations Runbook",
      content: "Key rotation and audit trails.",
    });
  }

  findUserByEmail(email: string): AppUser | undefined {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return undefined;
  }

  findUserById(id: string): AppUser | undefined {
    return this.users.get(id);
  }

  saveApiKey(record: StoredApiKey): void {
    this.apiKeys.set(record.id, record);
  }

  findApiKey(id: string): StoredApiKey | undefined {
    return this.apiKeys.get(id);
  }

  findDocument(id: string): SecretDocument | undefined {
    return this.documents.get(id);
  }

  updateDocument(id: string, title: string): SecretDocument | undefined {
    const existing = this.documents.get(id);
    if (!existing) return undefined;
    const updated: SecretDocument = { ...existing, title };
    this.documents.set(id, updated);
    return updated;
  }
}
