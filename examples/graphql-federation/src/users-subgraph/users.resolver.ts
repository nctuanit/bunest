import {
  Args,
  Context,
  ID,
  Query,
  ResolveReference,
  Resolver,
} from "@bunest/graphql";
import { User } from "./user.model";

@Resolver(() => User)
export class UsersResolver {
  public readonly receivedAuthHeaders: string[] = [];

  private readonly users = new Map<string, User>([
    ["u1", { id: "u1", name: "Alan Turing" }],
    ["u2", { id: "u2", name: "Ada Lovelace" }],
  ]);

  @Query(() => User, { nullable: true })
  user(
    @Args("id", { type: () => ID }) id: string,
    @Context() ctx?: { req?: Request },
  ): User | null {
    const forwarded = ctx?.req?.headers?.get("x-gateway-auth");
    if (forwarded) {
      this.receivedAuthHeaders.push(forwarded);
    }
    return this.users.get(id) ?? null;
  }

  @ResolveReference()
  resolveReference(ref: { __typename: string; id: string }): User | null {
    return this.users.get(ref.id) ?? null;
  }
}
